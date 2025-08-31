// app/api/relay-and-process/route.ts
import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ===== ENV (adjust to your .env) =====
// Required
const BASE_RPC = process.env.BASE_RPC || "https://sepolia.base.org";
const RELAYER_PK = process.env.BASE_RELAYER_PRIVATE_KEY!;
const MESSAGE_TRANSMITTER_V2 = process.env.BASE_MT_PROXY!;

// Hook address (prefer BASE_HOOK_ADDR, fallback to older BASE_GATEE_HOOK)
const GATEE_HOOK_ADDR = (process.env.BASE_HOOK_ADDR || process.env.BASE_GATEE_HOOK || "").toLowerCase();

// Optional
const RECEIVE_TO_AFTERMINT_DELAY_MS = Number(process.env.RECEIVE_TO_AFTERMINT_DELAY_MS || 2500);

// Destination domain (Base Sepolia)
const DEST_DOMAIN = 6;

// ===== ABIs =====
const MTv2_ABI = [
  "function receiveMessage(bytes message, bytes attestation) external returns (bool)"
];
const HOOK_ABI = [
  "function processAfterMint(address buyer, uint256 tokenId, uint256 qty, string calldata memo) external returns (bool)"
];

// ===== Types =====
type IrisMsg = {
  attestation?: string;
  message?: string;
  status?: string;
  eventNonce?: string;
  cctpVersion?: number;
  // Some responses put the decoded body here:
  decodedMessageBody?: {
    burnToken?: string;
    mintRecipient?: string;
    amount?: string;
    messageSender?: string;
    maxFee?: string;
    feeExecuted?: string;
    expirationBlock?: string;
    hookData?: string; // ABI-encoded: (buyer, tokenId, qty, memo)
  };
  // Others nest it here:
  decodedMessage?: {
    sourceDomain?: string | number;
    destinationDomain?: string | number;
    nonce?: string;
    messageBody?: string;
    decodedMessageBody?: IrisMsg["decodedMessageBody"];
  };
};

// ===== Helpers =====
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function isHexHash(s: string) { return /^0x[0-9a-fA-F]{64}$/.test(s); }
function toLower(x?: string | null) { return (x || "").toLowerCase(); }

async function pollIrisUntilComplete(
  sourceDomain: number,
  txHash: string,
  timeoutMs = 600_000
): Promise<IrisMsg> {
  const started = Date.now();
  const base = "https://iris-api-sandbox.circle.com/v2";
  while (Date.now() - started < timeoutMs) {
    const url = `${base}/messages/${sourceDomain}?transactionHash=${txHash}`;
    const r = await fetch(url, { cache: "no-store" });
    const txt = await r.text();

    let j: any;
    try {
      j = JSON.parse(txt);
    } catch {
      throw new Error(`IRIS returned non-JSON: ${txt.slice(0, 120)}…`);
    }

    const m: IrisMsg | null = j?.data?.messages?.[0] ?? j?.messages?.[0] ?? null;
    if (m?.status === "complete" && m.attestation && m.message) {
      return m;
    }
    await sleep(1000);
  }
  throw new Error("IRIS attestation not ready within timeout");
}

export async function POST(req: NextRequest) {
  try {
    // Body can be: { sourceDomain: number, txHash: string }
    const body = await req.json().catch(() => ({}));
    const sourceDomainRaw = body?.sourceDomain;
    const sd = Number(sourceDomainRaw);
    const txHash = String(body?.txHash || "");

    // Validate inputs (allow 0 for Ethereum Sepolia domain)
    if (!Number.isFinite(sd) || sd < 0) {
      return NextResponse.json({ ok: false, error: "Bad sourceDomain" }, { status: 400 });
    }
    if (!isHexHash(txHash)) {
      return NextResponse.json({ ok: false, error: "Bad txHash" }, { status: 400 });
    }
    if (!RELAYER_PK || !MESSAGE_TRANSMITTER_V2 || !GATEE_HOOK_ADDR) {
      return NextResponse.json(
        { ok: false, error: "Missing ENV (BASE_RELAYER_PRIVATE_KEY / BASE_MT_PROXY / BASE_HOOK_ADDR)" },
        { status: 500 }
      );
    }

    // 1) Poll IRIS until attestation is complete
    const m = await pollIrisUntilComplete(sd, txHash);
    const msgHex = m.message!;
    const att = m.attestation!;

    // Extract decodedMessage & decodedMessageBody robustly
    const dm: any = (m as any).decodedMessage || {};
    const dmb: any = (m as any).decodedMessageBody || (dm as any).decodedMessageBody || {};

    // 2) Sanity: destination must be Base Sepolia (domain 6)
    const destDom = Number(dm.destinationDomain ?? DEST_DOMAIN);
    if (destDom !== DEST_DOMAIN) {
      return NextResponse.json(
        { ok: false, error: `destinationDomain mismatch: ${destDom} != ${DEST_DOMAIN}` },
        { status: 400 }
      );
    }

    // 3) Validate mintRecipient equals our hook
    if (!dmb || !dmb.mintRecipient) {
      return NextResponse.json(
        { ok: false, error: "decodedMessageBody.mintRecipient missing from IRIS" },
        { status: 400 }
      );
    }
    const mintRecipient = toLower(dmb.mintRecipient);
    if (mintRecipient !== GATEE_HOOK_ADDR) {
      return NextResponse.json(
        { ok: false, error: `mintRecipient mismatch: ${mintRecipient} != ${GATEE_HOOK_ADDR}` },
        { status: 400 }
      );
    }

    // 4) Prepare signer & contracts on Base
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const wallet = new ethers.Wallet(RELAYER_PK, provider);
    const mt = new ethers.Contract(MESSAGE_TRANSMITTER_V2, MTv2_ABI, wallet);

    // 5) Relay (receiveMessage). If nonce already used, continue.
    let relayTxHash: string | null = null;
    let relayAlreadyDone = false;
    try {
      const txRelay = await mt.receiveMessage(msgHex, att);
      const rr = await txRelay.wait();
      relayTxHash = rr.hash;
    } catch (e: any) {
      const msg = String(e?.message || e).toLowerCase();
      const nonceUsed = msg.includes("nonce has already been used") || (msg.includes("nonce") && msg.includes("used"));
      if (!nonceUsed) {
        return NextResponse.json({ ok: false, error: `receiveMessage failed: ${String(e?.message || e)}` }, { status: 500 });
      }
      relayAlreadyDone = true;
    }

    // 6) Small delay to ensure USDC is visible in hook balance
    if (!relayAlreadyDone && RECEIVE_TO_AFTERMINT_DELAY_MS > 0) {
      await sleep(RECEIVE_TO_AFTERMINT_DELAY_MS);
    }

    // 7) Decode hookData → (buyer, tokenId, qty, memo) — always use attested data
    const hookData = dmb.hookData || "";
    if (typeof hookData !== "string" || !hookData.startsWith("0x")) {
      return NextResponse.json({ ok: false, error: "hookData missing/invalid from IRIS" }, { status: 400 });
    }

    let buyer: string, tokenId: bigint, qty: bigint, memo: string;
    try {
      [buyer, tokenId, qty, memo] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["address", "uint256", "uint256", "string"],
        hookData
      ) as unknown as [string, bigint, bigint, string];
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: `Bad hookData decode: ${e?.message || e}` }, { status: 400 });
    }

    // 8) Call processAfterMint on hook
    const hook = new ethers.Contract(GATEE_HOOK_ADDR, HOOK_ABI, wallet);
    const txProcess = await hook.processAfterMint(buyer, tokenId, qty, memo);
    const pr = await txProcess.wait();

    return NextResponse.json({
      ok: true,
      relayAlreadyDone,
      relayTxHash,
      processTxHash: pr.hash,
      buyer,
      tokenId: tokenId.toString(),
      qty: qty.toString(),
      memo,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}