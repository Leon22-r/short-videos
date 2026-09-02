import argparse
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

parser = argparse.ArgumentParser(description="Local transcript service (wraps lamba-function/handler.py)")
parser.add_argument("--api-key", default=os.environ.get("TRANSCRIPT_API_KEY", "local-dev"),
                    help="value handler checks the x-api-key header against (default: env TRANSCRIPT_API_KEY or 'local-dev')")
parser.add_argument("--port", type=int, default=8787, help="port to listen on (default: 8787)")
args = parser.parse_args()

# handler.handler() reads TRANSCRIPT_API_KEY from the environment at request time.
os.environ["TRANSCRIPT_API_KEY"] = args.api_key

sys.path.insert(0, str(Path("lamba-function").resolve()))
import handler

class Handler(BaseHTTPRequestHandler):
      def do_POST(self):
          length = int(self.headers.get("content-length", "0"))
          body = self.rfile.read(length).decode("utf-8")

          event = {
              "headers": {k: v for k, v in self.headers.items()},
              "body": body,
              "isBase64Encoded": False,
          }

          resp = handler.handler(event, None)
          payload = resp.get("body", "{}").encode("utf-8")

          self.send_response(resp.get("statusCode", 200))
          self.send_header("Content-Type", "application/json")
          self.send_header("Content-Length", str(len(payload)))
          self.end_headers()
          self.wfile.write(payload)

print(f"Listening on http://0.0.0.0:{args.port}/  (x-api-key: {args.api_key})")
HTTPServer(("0.0.0.0", args.port), Handler).serve_forever()
