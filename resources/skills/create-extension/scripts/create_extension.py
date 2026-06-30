#!/usr/bin/env python3
"""Scaffold and validate OpenCowork Custom Extension V1 folders."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path
from urllib.parse import urlparse


ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")
TOOL_NAME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")


def humanize_identifier(value: str) -> str:
    words = re.split(r"[_\-\s]+", value.strip())
    return " ".join(word.capitalize() for word in words if word) or value


def normalize_extension_id(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9_-]+", "_", value.strip().lower())
    normalized = re.sub(r"[_-]{2,}", "_", normalized).strip("_-")
    return normalized


def infer_origin(url: str) -> str | None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}"


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def build_minimal_manifest(extension_id: str, name: str, description: str) -> dict:
    return {
        "schemaVersion": 1,
        "id": extension_id,
        "name": name,
        "version": "0.1.0",
        "description": description,
        "permissions": {
            "network": ["https://jsonplaceholder.typicode.com"]
        },
        "tools": [
            {
                "name": "get_post",
                "description": "Fetch a demo post by id with a declarative HTTP GET tool.",
                "kind": "http",
                "readOnly": True,
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "Post id, for example 1"
                        }
                    },
                    "required": ["id"]
                },
                "http": {
                    "method": "GET",
                    "url": "https://jsonplaceholder.typicode.com/posts/{{input.id}}"
                }
            }
        ]
    }


def build_http_manifest(
    extension_id: str,
    name: str,
    description: str,
    url: str,
    network: list[str],
    method: str
) -> dict:
    return {
        "schemaVersion": 1,
        "id": extension_id,
        "name": name,
        "version": "0.1.0",
        "description": description,
        "permissions": {
            "network": network
        },
        "tools": [
            {
                "name": "fetch_data",
                "description": "Fetch data from the configured HTTP endpoint.",
                "kind": "http",
                "readOnly": method.upper() == "GET",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Optional query value used by the URL template"
                        },
                        "id": {
                            "type": "string",
                            "description": "Optional id value used by the URL template"
                        }
                    }
                },
                "http": {
                    "method": method.upper(),
                    "url": url
                }
            }
        ]
    }


def build_js_manifest(extension_id: str, name: str, description: str) -> dict:
    return {
        "schemaVersion": 1,
        "id": extension_id,
        "name": name,
        "version": "0.1.0",
        "description": description,
        "entry": "index.js",
        "tools": [
            {
                "name": "show_summary",
                "description": "Return a summary from a JavaScript extension handler.",
                "kind": "js",
                "handler": "showSummary",
                "readOnly": True,
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Optional text to summarize"
                        }
                    }
                }
            }
        ]
    }


def build_js_entry(name: str) -> str:
    return f"""globalThis.openCoworkExtension = {{
  handlers: {{
    async showSummary(input, ctx) {{
      const query = typeof input.query === 'string' ? input.query : ''
      const previous = await ctx.storage.get('last_query')
      await ctx.storage.set('last_query', query)
      return {{
        text: query ? `Summary for ${{query}}` : 'Summary ready',
        data: {{
          extension: {json.dumps(name)},
          query,
          previous
        }},
        ui: {{
          kind: 'card',
          title: {json.dumps(name)},
          body: query || 'No query provided'
        }}
      }}
    }}
  }}
}}
"""


def ensure_unique(values: list[str], label: str, errors: list[str]) -> None:
    seen: set[str] = set()
    for value in values:
        if value in seen:
            errors.append(f"duplicate {label}: {value}")
        seen.add(value)


def is_object(value: object) -> bool:
    return isinstance(value, dict)


def validate_manifest(manifest: dict, root: Path) -> list[str]:
    errors: list[str] = []

    if manifest.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")

    extension_id = manifest.get("id")
    if not isinstance(extension_id, str) or not ID_PATTERN.match(extension_id):
        errors.append("id must be 2-64 chars using lowercase letters, numbers, _ or -")
    elif root.name != extension_id:
        errors.append(f"folder name must match id: expected {extension_id}")

    if not isinstance(manifest.get("name"), str) or not manifest["name"].strip():
        errors.append("name is required")
    if not isinstance(manifest.get("version"), str) or not manifest["version"].strip():
        errors.append("version is required")

    tools = manifest.get("tools")
    if not isinstance(tools, list) or not tools:
        errors.append("tools must be a non-empty array")
        tools = []

    tool_names: list[str] = []
    for index, tool in enumerate(tools):
        if not is_object(tool):
            errors.append(f"tool at index {index} must be an object")
            continue
        name = tool.get("name")
        if not isinstance(name, str) or not TOOL_NAME_PATTERN.match(name):
            errors.append(f"invalid tool name at index {index}")
        else:
            tool_names.append(name)
        if not isinstance(tool.get("description"), str) or not tool["description"].strip():
            errors.append(f"tool {name or index} needs a description")
        if not is_object(tool.get("inputSchema")):
            errors.append(f"tool {name or index} needs an inputSchema object")
        kind = tool.get("kind")
        if kind == "http":
            http = tool.get("http")
            if not is_object(http):
                errors.append(f"http tool {name or index} needs http config")
                continue
            if not isinstance(http.get("method"), str) or not http["method"].strip():
                errors.append(f"http tool {name or index} needs http.method")
            if not isinstance(http.get("url"), str) or not http["url"].strip():
                errors.append(f"http tool {name or index} needs http.url")
        elif kind == "js":
            if not isinstance(tool.get("handler"), str) or not tool["handler"].strip():
                errors.append(f"js tool {name or index} needs handler")
        else:
            errors.append(f"tool {name or index} kind must be http or js")
            continue

    ensure_unique(tool_names, "tool name", errors)

    entry = manifest.get("entry")
    js_tools = [tool for tool in tools if is_object(tool) and tool.get("kind") == "js"]
    if js_tools and not isinstance(entry, str):
        errors.append("entry is required for JS tools")
    if isinstance(entry, str) and entry.strip() and not (root / entry).is_file():
        errors.append(f"entry file is missing: {entry}")

    renderers = manifest.get("renderers", [])
    renderer_names: list[str] = []
    if renderers is not None and not isinstance(renderers, list):
        errors.append("renderers must be an array when provided")
        renderers = []
    for index, renderer in enumerate(renderers):
        if not is_object(renderer):
            errors.append(f"renderer at index {index} must be an object")
            continue
        name = renderer.get("name")
        if not isinstance(name, str) or not name.strip():
            errors.append(f"renderer at index {index} needs name")
        else:
            renderer_names.append(name)
        if renderer.get("type") != "html":
            errors.append(f"renderer {name or index} type must be html")
        entry_name = renderer.get("entry")
        if not isinstance(entry_name, str) or not entry_name.strip():
            errors.append(f"renderer {name or index} needs entry")
            continue
        renderer_path = root / entry_name
        if not renderer_path.is_file():
            errors.append(f"renderer file is missing: {entry_name}")
            continue
        renderer_text = renderer_path.read_text(encoding="utf-8")
        if "extension-props" not in renderer_text:
            errors.append(f"renderer {entry_name} should listen for extension-props")
        if "escapeHtml" not in renderer_text and "textContent" not in renderer_text:
            errors.append(f"renderer {entry_name} should escape dynamic HTML values")
    ensure_unique(renderer_names, "renderer name", errors)

    permissions = manifest.get("permissions")
    network = permissions.get("network") if is_object(permissions) else None
    http_tools = [tool for tool in tools if is_object(tool) and tool.get("kind") == "http"]
    if http_tools and not isinstance(network, list):
        errors.append("permissions.network is required for HTTP tools")

    return errors


def read_manifest(root: Path) -> dict:
    manifest_path = root / "extension.json"
    if not manifest_path.is_file():
        raise ValueError(f"No extension.json found in {root}")
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"extension.json is invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("extension.json must contain an object")
    return data


def validate_extension(root: Path) -> None:
    manifest = read_manifest(root)
    errors = validate_manifest(manifest, root)
    if errors:
        raise ValueError("\n".join(f"- {error}" for error in errors))


def scaffold(args: argparse.Namespace) -> Path:
    extension_id = normalize_extension_id(args.extension_id)
    if extension_id != args.extension_id:
        print(f"Normalized extension id to: {extension_id}", file=sys.stderr)
    if not ID_PATTERN.match(extension_id):
        raise ValueError("extension id must be 2-64 chars using lowercase letters, numbers, _ or -")

    root = Path(args.path).expanduser().resolve() / extension_id
    if root.exists():
        if not args.force:
            raise ValueError(f"{root} already exists. Use --force to replace it.")
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)

    name = args.name or humanize_identifier(extension_id)
    description = args.description or f"{name} OpenCowork custom extension."

    if args.template == "minimal":
        write_json(root / "extension.json", build_minimal_manifest(extension_id, name, description))
    elif args.template == "http":
        url = args.url or "https://jsonplaceholder.typicode.com/posts/{{input.id}}"
        network = list(args.network)
        inferred = infer_origin(url)
        if not network and inferred:
            network = [inferred]
        if not network:
            raise ValueError("Could not infer network origin from --url. Provide --network.")
        method = args.method.upper()
        write_json(
            root / "extension.json",
            build_http_manifest(extension_id, name, description, url, network, method)
        )
    elif args.template == "js":
        write_json(root / "extension.json", build_js_manifest(extension_id, name, description))
        (root / "index.js").write_text(build_js_entry(name), encoding="utf-8")
    else:
        raise ValueError(f"Unknown template: {args.template}")

    validate_extension(root)
    return root


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("extension_id", help="Extension id and folder name")
    parser.add_argument(
        "--path",
        required=True,
        help="Parent directory where <extension-id>/ will be created or validated"
    )
    parser.add_argument(
        "--template",
        choices=["minimal", "http", "js"],
        default="minimal",
        help="Scaffold template to create"
    )
    parser.add_argument("--name", help="Display name for extension.json")
    parser.add_argument("--description", help="Description for extension.json")
    parser.add_argument("--force", action="store_true", help="Replace an existing extension folder")
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Validate an existing <path>/<extension-id> without writing files"
    )
    parser.add_argument(
        "--url",
        help="HTTP template URL. Supports {{input.foo}} and {{config.foo}} interpolation."
    )
    parser.add_argument(
        "--network",
        action="append",
        default=[],
        help="Allowed network origin or URL prefix. Repeat for multiple entries."
    )
    parser.add_argument("--method", default="GET", help="HTTP method for the http template")
    return parser


def main(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    extension_id = normalize_extension_id(args.extension_id)
    root = Path(args.path).expanduser().resolve() / extension_id

    try:
        if args.validate_only:
            validate_extension(root)
            print(f"Validated extension: {root}")
            return 0

        created = scaffold(args)
        print(f"Created extension: {created}")
        print("Install it from OpenCowork Settings -> Extensions, then enable it.")
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
