#!/usr/bin/env python3
"""Argus Block D - SUT-side TCP exposure shim for the AMW PayPal demo gateway.

Deployment plumbing only, not a repair of the SUT: it wires together the
demo's own public seams -

* ``mini_gateway.MiniGateway`` (the demo's reference gateway) served over real
  TCP via uvicorn, so an external black-box driver can speak its documented
  HTTP surface (wallets, permits, MCP tools/call, receipts, trust keys);
* ``PayPalClient`` constructed with an explicit ``transport`` (the parameter
  the demo itself declares "so tests can route calls"), pointed at the Argus
  fault-injection proxy. PayPalClient refuses plain-HTTP base URLs when no
  transport is given, so this is the intended seam for a local rail.

Nothing in the demo's code is modified; nothing in the governed call path is
bypassed. Prints one JSON "ready" line on stdout for the Argus driver.

Usage:
  python3 serve_gateway.py --demo-root /path/to/amw-paypal-agent-demo \
      --port 8321 --proxy-url http://127.0.0.1:8888 --price-usd 25.00 \
      [--db /tmp/sut.db] [--admin-key <key>]   # same db+key after a hard kill
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import sys
import tempfile
from decimal import Decimal
from pathlib import Path

import httpx
import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo-root", required=True, type=Path)
    parser.add_argument("--port", type=int, default=8321)
    parser.add_argument("--proxy-url", default="http://127.0.0.1:8888")
    parser.add_argument("--price-usd", default="25.00")
    parser.add_argument("--db", default="")
    parser.add_argument("--admin-key", default="")
    args = parser.parse_args()

    root = args.demo_root.resolve()
    for p in (
        root,
        root / "vendor" / "b2a_sdk" / "src",
        root / "vendor" / "openai-agent-middleware" / "src",
    ):
        if str(p) not in sys.path:
            sys.path.insert(0, str(p))

    from mini_gateway import MiniGateway
    from paypal_client import PayPalClient
    from paypal_tool import register_checkout_tool, usd_to_credits

    # Placeholder rail credentials; the mock rail accepts any client id/secret.
    os.environ.setdefault("PAYPAL_CLIENT_ID", "argus-dummy-client-id")
    os.environ.setdefault("PAYPAL_CLIENT_SECRET", "argus-dummy-client-secret")

    price_usd = Decimal(args.price_usd)
    admin_key = args.admin_key or secrets.token_urlsafe(32)
    db_path = Path(args.db) if args.db else Path(tempfile.gettempdir()) / "argus-sut-gateway.db"

    gw = MiniGateway(db_path, admin_key=admin_key, key_id="argus-block-d-sut")
    stale = gw.start()
    # The demo's own seam: route PayPalClient over a real transport to the proxy.
    paypal = PayPalClient(base_url=args.proxy_url, transport=httpx.AsyncHTTPTransport())
    register_checkout_tool(gw.registry, paypal, price_usd=price_usd)

    config = uvicorn.Config(
        gw.app, host="127.0.0.1", port=args.port, log_level="warning", access_log=False
    )
    server = uvicorn.Server(config)

    print(
        json.dumps(
            {
                "event": "ready",
                "port": args.port,
                "admin_key": admin_key,
                "proxy_url": args.proxy_url,
                "price_credits": str(usd_to_credits(price_usd)),
                "stale_recovered": stale,
                "db": str(db_path),
            }
        ),
        flush=True,
    )

    asyncio.run(server.serve())


if __name__ == "__main__":
    main()
