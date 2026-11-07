#!/usr/bin/env python3
"""Test fixture only: a minimal MCP stdio server. Not installed by default."""
import json
import os
import sys

TOOLS = [
    {"name": n, "description": n, "inputSchema": {"type": "object", "properties": {}}}
    for n in ("hello", "pid", "crash", "undeclared")
]


def reply(id_, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": id_, "result": result}) + "\n")
    sys.stdout.flush()


def text(s):
    return {"content": [{"type": "text", "text": s}]}


for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:
        continue
    method = msg["method"]
    if method == "initialize":
        reply(msg["id"], {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "hello", "version": "0.1.0"}})
    elif method == "tools/list":
        reply(msg["id"], {"tools": TOOLS})
    elif method == "tools/call":
        name = msg["params"]["name"]
        args = msg["params"].get("arguments", {})
        if name == "crash":
            os._exit(1)
        if name == "pid":
            reply(msg["id"], text(str(os.getpid())))
        else:
            reply(msg["id"], text("hello " + str(args.get("who", "world"))))
