/**
 * SUT server role (Block B family BC): x402 v2 resource server on Base Sepolia.
 *
 * Built on the OFFICIAL x402 reference stack (@x402/express, @x402/core,
 * @x402/evm v2.28.0) following the upstream example
 * x402-foundation/x402: examples/typescript/servers/express/index.ts.
 *
 * Env:
 *   EVM_ADDRESS       receiving wallet (payTo) of the SUT
 *   FACILITATOR_URL   facilitator endpoint (default public https://x402.org/facilitator)
 *   PORT              listen port (default 4021)
 */
import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
  console.error("Missing required environment variable: EVM_ADDRESS");
  process.exit(1);
}
const facilitatorUrl = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
const port = Number(process.env.PORT ?? 4021);

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: "eip155:84532", // Base Sepolia
            payTo: evmAddress,
          },
        ],
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register(
      "eip155:84532",
      new ExactEvmScheme(),
    ),
  ),
);

app.get("/weather", (req, res) => {
  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

app.listen(port, () => {
  console.log(`[sut-server] listening at http://localhost:${port} (payTo=${evmAddress}, facilitator=${facilitatorUrl})`);
});
