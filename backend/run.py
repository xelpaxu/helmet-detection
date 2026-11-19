"""Start a single model worker. Execute: .venv/Scripts/python run.py"""
import uvicorn
from pathlib import Path
import sys

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, ws_max_size=5 * 1024 * 1024, ws_max_queue=1)
