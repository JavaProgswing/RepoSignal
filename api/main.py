from __future__ import annotations

import asyncio
import base64
import math
import os
import re
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


app = FastAPI(title="RepoSignal API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4173", "http://127.0.0.1:4173", "http://localhost:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


default_db_path = Path("/tmp/reposignal.db") if os.getenv("VERCEL") else Path(__file__).resolve().parents[1] / "reposignal.db"
DB_PATH = Path(os.getenv("REPOSIGNAL_DB", default_db_path))


def ensure_history_db() -> None:
    with sqlite3.connect(DB_PATH) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS item_snapshots (
                repository TEXT NOT NULL,
                scan_id TEXT NOT NULL,
                item_key TEXT NOT NULL,
                comments INTEGER NOT NULL,
                score INTEGER NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (repository, scan_id, item_key)
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_snapshots_repo_scan ON item_snapshots(repository, scan_id)"
        )


def previous_snapshot(repository: str) -> tuple[str | None, dict[str, dict[str, Any]]]:
    ensure_history_db()
    with sqlite3.connect(DB_PATH) as connection:
        row = connection.execute(
            "SELECT MAX(scan_id) FROM item_snapshots WHERE repository = ?", (repository,)
        ).fetchone()
        scan_id = row[0] if row else None
        if not scan_id:
            return None, {}
        rows = connection.execute(
            "SELECT item_key, comments, score, updated_at FROM item_snapshots WHERE repository = ? AND scan_id = ?",
            (repository, scan_id),
        ).fetchall()
    return scan_id, {
        item_key: {"comments": comments, "score": score, "updated_at": updated_at}
        for item_key, comments, score, updated_at in rows
    }


def save_snapshot(repository: str, scan_id: str, items: list[dict[str, Any]]) -> None:
    ensure_history_db()
    rows = [
        (
            repository,
            scan_id,
            f"{item['kind']}:{item['number']}",
            item["comments"],
            item["score"],
            item["updated_at"],
        )
        for item in items
    ]
    with sqlite3.connect(DB_PATH) as connection:
        connection.executemany(
            "INSERT INTO item_snapshots(repository, scan_id, item_key, comments, score, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
        old_scans = connection.execute(
            "SELECT DISTINCT scan_id FROM item_snapshots WHERE repository = ? ORDER BY scan_id DESC",
            (repository,),
        ).fetchall()[10:]
        for (old_scan,) in old_scans:
            connection.execute(
                "DELETE FROM item_snapshots WHERE repository = ? AND scan_id = ?",
                (repository, old_scan),
            )


class AnalyzeRequest(BaseModel):
    repository: str = Field(min_length=3, max_length=300)
    token: str | None = Field(default=None, max_length=500)
    max_items: int = Field(default=30, ge=5, le=50)


def parse_repository(value: str) -> tuple[str, str]:
    cleaned = value.strip().rstrip("/")
    if "github.com" in cleaned:
        parsed = urlparse(cleaned if "://" in cleaned else f"https://{cleaned}")
        parts = [part for part in parsed.path.split("/") if part]
    else:
        parts = [part for part in cleaned.split("/") if part]
    if len(parts) < 2:
        raise ValueError("Use owner/repository or a full GitHub repository URL.")
    owner, repo = parts[0], parts[1].removesuffix(".git")
    valid = re.compile(r"^[A-Za-z0-9_.-]+$")
    if not valid.match(owner) or not valid.match(repo):
        raise ValueError("The repository name contains unsupported characters.")
    return owner, repo


class GitHubClient:
    def __init__(self, token: str | None):
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "RepoSignal/1.0",
        }
        if token:
            headers["Authorization"] = f"Bearer {token.strip()}"
        self.client = httpx.AsyncClient(
            base_url="https://api.github.com",
            headers=headers,
            timeout=httpx.Timeout(20.0),
            follow_redirects=True,
        )
        self.remaining: int | None = None
        self.limit: int | None = None

    async def close(self) -> None:
        await self.client.aclose()

    async def get(self, path: str, *, params: dict[str, Any] | None = None, optional: bool = False) -> Any:
        response = await self.client.get(path, params=params)
        if response.headers.get("x-ratelimit-remaining"):
            self.remaining = int(response.headers["x-ratelimit-remaining"])
        if response.headers.get("x-ratelimit-limit"):
            self.limit = int(response.headers["x-ratelimit-limit"])
        if optional and response.status_code in {403, 404, 409, 422}:
            return None
        if response.status_code == 401:
            raise HTTPException(401, "GitHub rejected the token. Remove it or provide a valid token.")
        if response.status_code == 403 and response.headers.get("x-ratelimit-remaining") == "0":
            raise HTTPException(429, "GitHub API rate limit reached. Add a token and try again.")
        if response.status_code == 404:
            raise HTTPException(404, "Repository not found or it is private. Private repositories require a token.")
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise HTTPException(response.status_code, f"GitHub request failed: {response.text[:180]}") from exc
        return response.json()


def tokenize(text: str) -> list[str]:
    stop = {
        "the", "a", "an", "and", "or", "to", "of", "in", "for", "on", "with", "is",
        "it", "this", "that", "when", "after", "from", "be", "not", "using", "add",
    }
    return [word for word in re.findall(r"[a-z0-9_]+", text.lower()) if len(word) > 2 and word not in stop]


def duplicate_matches(items: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    documents = [tokenize(f"{item['title']} {item.get('body') or ''}") for item in items]
    doc_frequency: Counter[str] = Counter()
    for words in documents:
        doc_frequency.update(set(words))
    total = max(len(documents), 1)
    vectors: list[dict[str, float]] = []
    norms: list[float] = []
    for words in documents:
        counts = Counter(words)
        vector = {
            word: count * (math.log((total + 1) / (doc_frequency[word] + 1)) + 1)
            for word, count in counts.items()
        }
        vectors.append(vector)
        norms.append(math.sqrt(sum(value * value for value in vector.values())) or 1.0)

    result: dict[int, dict[str, Any]] = {}
    for left in range(len(items)):
        best_score, best_index = 0.0, -1
        for right in range(len(items)):
            if left == right or items[left]["kind"] != items[right]["kind"]:
                continue
            shared = vectors[left].keys() & vectors[right].keys()
            score = sum(vectors[left][word] * vectors[right][word] for word in shared)
            score /= norms[left] * norms[right]
            if score > best_score:
                best_score, best_index = score, right
        if best_index >= 0 and best_score >= 0.36:
            match = items[best_index]
            result[items[left]["number"]] = {
                "number": match["number"],
                "title": match["title"],
                "similarity": round(best_score, 2),
                "url": match["url"],
            }
    return result


def iso_age_hours(value: str) -> float:
    created = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return max((datetime.now(timezone.utc) - created).total_seconds() / 3600, 0)


def label_names(raw: dict[str, Any]) -> list[str]:
    return [label.get("name", "") for label in raw.get("labels", []) if label.get("name")]


def reaction_count(raw: dict[str, Any]) -> int:
    reactions = raw.get("reactions") or {}
    return sum(value for key, value in reactions.items() if key not in {"url", "total_count"} and isinstance(value, int))


def score_item(item: dict[str, Any], duplicate: dict[str, Any] | None, policy_names: set[str]) -> dict[str, Any]:
    raw = item["raw"]
    labels = label_names(raw)
    label_text = " ".join(labels).lower()
    title_body = f"{item['title']} {item.get('body') or ''}".lower()
    comments = int(raw.get("comments") or 0)
    reactions = reaction_count(raw)
    updated_hours = iso_age_hours(raw["updated_at"])
    created_hours = iso_age_hours(raw["created_at"])
    score = 24
    evidence: list[dict[str, str]] = []
    signals: list[str] = []
    category, action = "Needs review", "Review evidence"

    if comments:
        score += min(comments * 2, 16)
        evidence.append({"label": "Discussion", "value": f"{comments} comments", "tone": "attention" if comments >= 4 else "neutral"})
        signals.append(f"{comments} comments")
    if reactions:
        score += min(reactions * 2, 12)
        evidence.append({"label": "Community signal", "value": f"{reactions} reactions", "tone": "attention"})
        signals.append(f"{reactions} reactions")
    if updated_hours <= 24:
        score += 8
        evidence.append({"label": "Recent activity", "value": "Updated within 24 hours", "tone": "positive"})
    elif updated_hours <= 168:
        score += 4

    urgent_words = ("security", "vulnerability", "critical", "regression", "data loss", "crash")
    matched_urgent = next((word for word in urgent_words if word in title_body or word in label_text), None)
    if matched_urgent:
        score += 25 if matched_urgent in {"security", "vulnerability", "data loss"} else 17
        evidence.append({"label": "Impact signal", "value": f"Mentions {matched_urgent}", "tone": "risk"})
        signals.append(matched_urgent.title())
        category = "High impact"

    if item["kind"] == "Pull request":
        details = item.get("details") or {}
        files = item.get("files") or []
        filenames = [entry.get("filename", "") for entry in files]
        changed = int(details.get("changed_files") or len(files))
        additions = int(details.get("additions") or 0)
        deletions = int(details.get("deletions") or 0)
        draft = bool(details.get("draft"))
        tests_changed = any(re.search(r"(^|/)(test|tests|spec|specs)(/|\.)(.*)|(_test|\.test|\.spec)\.", name.lower()) for name in filenames)
        sensitive = [name for name in filenames if re.search(r"auth|security|permission|crypto|token|session", name, re.I)]
        documentation_only = bool(filenames) and all(re.search(r"(^docs?/|\.md$|\.txt$)", name, re.I) for name in filenames)

        evidence.append({"label": "Change size", "value": f"{changed} files · +{additions} / -{deletions}", "tone": "attention" if changed > 15 else "neutral"})
        if changed > 25:
            score += 14
            signals.append("Large change")
        elif changed > 10:
            score += 8
        if sensitive:
            score += 23
            category = "Security surface"
            signals.append("Sensitive files")
            evidence.append({"label": "Sensitive paths", "value": f"{len(sensitive)} auth or security-related files", "tone": "risk"})
        if tests_changed:
            score += 4
            signals.append("Tests included")
            evidence.append({"label": "Tests", "value": "Related test files changed", "tone": "positive"})
        elif filenames and not documentation_only:
            score += 13
            signals.append("No tests")
            evidence.append({"label": "Tests", "value": "No test files changed", "tone": "risk"})
            action = "Request test coverage"
        if draft:
            score -= 20
            category, action = "Draft", "Wait for author"
            evidence.append({"label": "Review state", "value": "Marked as draft", "tone": "neutral"})
        elif documentation_only:
            score -= 8
            category, action = "Low-risk change", "Quick review"
            signals.append("Docs only")

        checks = item.get("checks") or []
        conclusions = [check.get("conclusion") for check in checks if check.get("status") == "completed"]
        failing = sum(value in {"failure", "timed_out", "cancelled", "action_required"} for value in conclusions)
        pending = sum(check.get("status") != "completed" for check in checks)
        if failing:
            score += 16
            category, action = "Checks failing", "Inspect failing checks"
            signals.append(f"{failing} checks failing")
            evidence.append({"label": "CI status", "value": f"{failing} checks failing", "tone": "risk"})
        elif pending:
            score -= 4
            evidence.append({"label": "CI status", "value": f"{pending} checks pending", "tone": "attention"})
        elif checks:
            score += 3
            signals.append("CI passing")
            evidence.append({"label": "CI status", "value": f"{len(checks)} checks passing", "tone": "positive"})
            if tests_changed and not sensitive and changed <= 15:
                category, action = "Ready to review", "Review and merge if approved"
    else:
        body = (item.get("body") or "").strip()
        if len(body) < 80:
            score += 7
            category, action = "Needs information", "Ask for reproduction details"
            signals.append("Thin report")
            evidence.append({"label": "Report quality", "value": "Description is missing useful detail", "tone": "attention"})
        else:
            evidence.append({"label": "Report quality", "value": "Detailed description provided", "tone": "positive"})
        if created_hours > 24 * 60:
            score += 6
            signals.append("Long-running")
            evidence.append({"label": "Age", "value": f"Open for {int(created_hours / 24)} days", "tone": "attention"})

    if duplicate:
        score += 6
        if category not in {"Security surface", "High impact"}:
            category = "Possible duplicate"
        if action == "Review evidence":
            action = "Compare related work"
        signals.append(f"{round(duplicate['similarity'] * 100)}% similar")
        evidence.append({"label": "Semantic match", "value": f"Similar to #{duplicate['number']}", "tone": "attention"})

    if "CODEOWNERS" in policy_names and item["kind"] == "Pull request":
        evidence.append({"label": "Repository policy", "value": "CODEOWNERS rules available", "tone": "neutral"})
    score = max(5, min(99, score))
    confidence = min(0.96, 0.62 + len(evidence) * 0.055)
    reason = ", ".join(signals[:2]).lower() or "the current repository evidence"
    if item["kind"] == "Pull request":
        draft_response = (
            f"Thanks for the contribution. RepoSignal flagged this as “{category.lower()}” based on {reason}. "
            f"Suggested next step: {action.lower()}. A maintainer should verify the evidence above before posting this reply."
        )
    else:
        draft_response = (
            f"Thanks for the report. We identified this as “{category.lower()}” based on {reason}. "
            f"Suggested next step: {action.lower()}. Could you add any missing reproduction details while a maintainer reviews it?"
        )

    details = item.get("details") or {}
    changed_files = int(details.get("changed_files") or len(item.get("files") or []))
    if item["kind"] == "Pull request":
        estimated_minutes = min(45, max(8, 6 + changed_files * 2 + comments))
    else:
        estimated_minutes = min(25, max(5, 5 + min(comments, 8)))
    estimated_minutes = int(5 * round(estimated_minutes / 5))
    if category == "Ready to review":
        outcome = "Land a ready change"
    elif category in {"Security surface", "High impact"}:
        outcome = "Reduce project risk"
    elif category == "Possible duplicate":
        outcome = "Collapse duplicate work"
    elif category == "Needs information":
        outcome = "Unblock the report"
    elif item["kind"] == "Pull request":
        outcome = "Move a contribution forward"
    else:
        outcome = "Clarify maintainer ownership"
    urgent_evidence = next(
        (entry["value"] for entry in evidence if entry["tone"] in {"risk", "attention"}),
        evidence[0]["value"] if evidence else "Recently active repository work",
    )
    why_now = f"{urgent_evidence}. Estimated {estimated_minutes} minutes to take the next step."

    return {
        "number": item["number"], "kind": item["kind"], "title": item["title"],
        "author": raw.get("user", {}).get("login", "unknown"),
        "avatar": raw.get("user", {}).get("avatar_url"), "url": item["url"],
        "created_at": raw["created_at"], "updated_at": raw["updated_at"],
        "labels": labels, "comments": comments, "score": score,
        "confidence": round(confidence, 2), "category": category, "action": action,
        "summary": evidence[0]["value"] if evidence else "Open repository work awaiting review.",
        "signals": signals[:4], "evidence": evidence, "duplicate": duplicate,
        "draft_response": draft_response,
        "files": [entry.get("filename") for entry in (item.get("files") or [])[:12]],
        "additions": int((item.get("details") or {}).get("additions") or 0),
        "deletions": int((item.get("details") or {}).get("deletions") or 0),
        "draft": bool((item.get("details") or {}).get("draft")),
        "estimated_minutes": estimated_minutes,
        "outcome": outcome,
        "why_now": why_now,
    }


async def fetch_pr_context(client: GitHubClient, owner: str, repo: str, raw: dict[str, Any]) -> dict[str, Any]:
    number = raw["number"]
    details, files = await asyncio.gather(
        client.get(f"/repos/{owner}/{repo}/pulls/{number}", optional=True),
        client.get(f"/repos/{owner}/{repo}/pulls/{number}/files", params={"per_page": 100}, optional=True),
    )
    checks: list[dict[str, Any]] = []
    if details and details.get("head", {}).get("sha"):
        check_data = await client.get(
            f"/repos/{owner}/{repo}/commits/{details['head']['sha']}/check-runs",
            params={"per_page": 100}, optional=True,
        )
        checks = (check_data or {}).get("check_runs", [])
    return {"details": details or {}, "files": files or [], "checks": checks}


async def fetch_policies(client: GitHubClient, owner: str, repo: str) -> list[dict[str, Any]]:
    candidates = [
        ("CODEOWNERS", "CODEOWNERS"), ("CODEOWNERS", ".github/CODEOWNERS"),
        ("CONTRIBUTING.md", "CONTRIBUTING.md"), ("CONTRIBUTING.md", ".github/CONTRIBUTING.md"),
        ("SECURITY.md", "SECURITY.md"), ("SECURITY.md", ".github/SECURITY.md"),
    ]
    responses = await asyncio.gather(*[
        client.get(f"/repos/{owner}/{repo}/contents/{path}", optional=True) for _, path in candidates
    ])
    seen: set[str] = set()
    policies: list[dict[str, Any]] = []
    for (name, path), response in zip(candidates, responses):
        if not response or name in seen:
            continue
        seen.add(name)
        content = ""
        if response.get("content"):
            try:
                content = base64.b64decode(response["content"]).decode("utf-8", "ignore")[:6000]
            except (ValueError, UnicodeError):
                content = ""
        policies.append({
            "name": name, "path": path, "url": response.get("html_url"),
            "preview": re.sub(r"\s+", " ", content)[:220],
        })
    return policies


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "reposignal"}


@app.post("/api/analyze")
async def analyze(request: AnalyzeRequest) -> dict[str, Any]:
    try:
        owner, repo = parse_repository(request.repository)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    client = GitHubClient(request.token or os.getenv("GITHUB_TOKEN"))
    try:
        repo_data, raw_items, policies = await asyncio.gather(
            client.get(f"/repos/{owner}/{repo}"),
            client.get(f"/repos/{owner}/{repo}/issues", params={
                "state": "open", "sort": "updated", "direction": "desc", "per_page": request.max_items,
            }),
            fetch_policies(client, owner, repo),
        )
        pr_items = [raw for raw in raw_items if "pull_request" in raw][:8]
        pr_contexts = await asyncio.gather(*[
            fetch_pr_context(client, owner, repo, raw) for raw in pr_items
        ])
        context_by_number = {raw["number"]: context for raw, context in zip(pr_items, pr_contexts)}
        normalized = []
        for raw in raw_items:
            is_pr = "pull_request" in raw
            normalized.append({
                "number": raw["number"], "kind": "Pull request" if is_pr else "Issue",
                "title": raw.get("title") or "Untitled", "body": raw.get("body") or "",
                "url": raw.get("html_url"), "raw": raw, **context_by_number.get(raw["number"], {}),
            })

        duplicates = duplicate_matches(normalized)
        policy_names = {policy["name"] for policy in policies}
        scored = [score_item(item, duplicates.get(item["number"]), policy_names) for item in normalized]
        scored.sort(key=lambda item: (item["score"], item["updated_at"]), reverse=True)

        previous_scan, previous_items = previous_snapshot(repo_data["full_name"])
        new_items = 0
        changed_items = 0
        for item in scored:
            item_key = f"{item['kind']}:{item['number']}"
            previous = previous_items.get(item_key)
            if previous is None:
                status = "new"
                comments_delta = item["comments"]
                score_delta = item["score"]
                new_items += 1
            else:
                comments_delta = item["comments"] - previous["comments"]
                score_delta = item["score"] - previous["score"]
                changed = comments_delta != 0 or score_delta != 0 or item["updated_at"] != previous["updated_at"]
                status = "changed" if changed else "unchanged"
                changed_items += int(changed)
            item["activity"] = {
                "status": status,
                "comments_delta": comments_delta,
                "score_delta": score_delta,
            }

        scan_id = datetime.now(timezone.utc).isoformat()
        save_snapshot(repo_data["full_name"], scan_id, scored)
        return {
            "repository": {
                "owner": owner, "name": repo, "full_name": repo_data["full_name"],
                "description": repo_data.get("description"), "url": repo_data["html_url"],
                "stars": repo_data.get("stargazers_count", 0), "forks": repo_data.get("forks_count", 0),
                "open_issues": repo_data.get("open_issues_count", 0),
                "default_branch": repo_data.get("default_branch"),
                "avatar": repo_data.get("owner", {}).get("avatar_url"),
                "private": repo_data.get("private", False),
            },
            "items": scored, "policies": policies,
            "summary": {
                "analyzed": len(scored),
                "needs_attention": sum(item["score"] >= 50 for item in scored),
                "ready": sum(item["category"] == "Ready to review" for item in scored),
                "duplicates": sum(bool(item["duplicate"]) for item in scored),
                "issues": sum(item["kind"] == "Issue" for item in scored),
                "pull_requests": sum(item["kind"] == "Pull request" for item in scored),
                "new_items": new_items,
                "changed_items": changed_items,
                "previous_scan": previous_scan,
            },
            "rate_limit": {"remaining": client.remaining, "limit": client.limit},
            "analyzed_at": datetime.now(timezone.utc).isoformat(),
        }
    except httpx.RequestError as exc:
        raise HTTPException(502, f"Could not reach GitHub: {exc}") from exc
    finally:
        await client.close()


dist_dir = Path(__file__).resolve().parents[1] / "dist"
if dist_dir.exists() and not os.getenv("VERCEL"):
    app.mount("/assets", StaticFiles(directory=dist_dir / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def serve_app(path: str) -> FileResponse:
        requested = dist_dir / path
        if path and requested.is_file() and dist_dir in requested.resolve().parents:
            return FileResponse(requested)
        return FileResponse(dist_dir / "index.html")
