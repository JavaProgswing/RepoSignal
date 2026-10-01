from fastapi import FastAPI

from api.main import health


app = FastAPI()
app.add_api_route("/", health, methods=["GET"])
app.add_api_route("/api/health", health, methods=["GET"])

