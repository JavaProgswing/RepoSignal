from fastapi import FastAPI

from api.main import AnalyzeRequest, analyze


app = FastAPI()
app.add_api_route("/", analyze, methods=["POST"])
app.add_api_route("/api/analyze", analyze, methods=["POST"])

