#!/usr/bin/env python3
"""Robust static server for the viz test harness.

Plain `python -m http.server` on Windows raises ConnectionAbortedError /
BrokenPipeError whenever the browser cancels a request (i.e. on every
navigation) and can drop concurrent or large fetches — which makes harness
verification flaky. This server is threaded, reuses addresses, and swallows the
benign connection-reset errors so loads are reliable.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
RESET_ERRORS = (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass  # quiet: logging to stderr under load slows Windows serving

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except RESET_ERRORS:
            self.close_connection = True

    def copyfile(self, source, outputfile):
        # body transfer can abort mid-send (large harness.json + navigation)
        try:
            super().copyfile(source, outputfile)
        except RESET_ERRORS:
            pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print("serving on http://127.0.0.1:%d (robust/threaded)" % PORT)
        httpd.serve_forever()
