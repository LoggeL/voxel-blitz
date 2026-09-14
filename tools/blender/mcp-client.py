"""Call the configured Blender MCP server through the official MCP Python SDK.

Run with the Python environment belonging to the installed blender-mcp server.
This also works before the desktop app refreshes its MCP tool list.
"""

import argparse
import asyncio
import base64
import json
import os
import sys
from datetime import timedelta
from pathlib import Path
import tomllib

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tool", help="Tool name, or list")
    parser.add_argument("--code-file", type=Path)
    parser.add_argument("--arguments", default="{}")
    parser.add_argument("--image-output", type=Path)
    args = parser.parse_args()
    config_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    config = tomllib.loads((config_home / "config.toml").read_text())
    server = config["mcp_servers"]["blender"]
    params = StdioServerParameters(
        command=server["command"], args=server.get("args", []),
        env={**os.environ, **server.get("env", {})},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=240)) as session:
            await session.initialize()
            if args.tool == "list":
                result = await session.list_tools()
                print(json.dumps([{"name": t.name, "inputSchema": t.inputSchema} for t in result.tools], indent=2))
                return
            arguments = json.loads(args.arguments)
            if args.code_file:
                arguments["code"] = args.code_file.read_text()
            result = await session.call_tool(args.tool, arguments)
            failed = bool(result.isError)
            for item in result.content:
                if item.type == "text":
                    print(item.text)
                    failed = failed or item.text.startswith('Error ') or 'Traceback (most recent call last)' in item.text
                elif item.type == "image" and args.image_output:
                    args.image_output.parent.mkdir(parents=True, exist_ok=True)
                    args.image_output.write_bytes(base64.b64decode(item.data))
                    print(f"Image saved: {args.image_output}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
