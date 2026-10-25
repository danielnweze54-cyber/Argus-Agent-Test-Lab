/**
 * SUT client role (Block B family BS): x402 v2 paying client on Base Sepolia.
 *
 * Built on the OFFICIAL x402 reference stack (@x402/fetch, @x402/evm v2.28.0)
 * following the upstream example
 * x402-foundation/x402: examples/typescript/clients/fetch/index.ts.
 *
 * Env:
 *   EVM_PRIVATE_KEY      SUT client wallet key (testnet one-shot)
 *   RESOURCE_SERVER_URL  base URL of the payment-demanding server (Argus bad server)
 *   ENDPOINT_PATH        resource path (default /weather)
 *
 * No EVM_RPC_URL is configured on purpose: the client signs EIP-3009
 * authorizations purely off-chain (black-box behaviour, no balance gates).
 */
import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://127.0.0.1:4401";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;

if (!evmPrivateKey) {
  console.error("Missing required EVM_PRIVATE_KEY environment variable");
  process.exit(1);
}

async function main(): Promise<void> {
  const client = new x402Client();
  client.setSpendControls({
    maxAmountPerPayment: "$1",
  });
  const evmSigner = privateKeyToAccount(evmPrivateKey!);
  client.register("eip155:*", new ExactEvmScheme(evmSigner));

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);

  console.log(`[sut-client] requesting: ${url}`);
  const t0 = performance.now();
  const response = await fetchWithPayment(url, { method: "GET" });
  const result = await httpClient.processResponse(response);
  console.dir(result, { depth: null });
  console.log(`[sut-client] completed in ${((performance.now() - t0) / 1000).toFixed(3)}s, http=${response.status}`);
}

main().catch((error: unknown) => {
  const message =
    error && typeof error === "object" && "response" in error
      ? (error as { response?: { data?: { error?: string } } }).response?.data?.error
      : undefined;
  console.error(`[sut-client] error: ${message ?? String(error)}`);
  process.exit(1);
});
