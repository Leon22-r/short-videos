import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

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

print("Listening on http://0.0.0.0:8787/transcript")
HTTPServer(("0.0.0.0", 8787), Handler).serve_forever()
