"use client";
import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";

/** ===== Helpers (generic) ===== */
function fmt6(n: bigint) { return ethers.formatUnits(n, 6); }
function toHexChainIdUnpadded(input: number | string): `0x${string}` {
  const n = typeof input === "string" ? (input.startsWith("0x") ? parseInt(input, 16) : Number(input)) : input;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Bad chainId: ${input}`);
  return ("0x" + n.toString(16)) as `0x${string}`;
}
async function ensureChain(chainId: number | string, add?: any) {
  const hex = toHexChainIdUnpadded(chainId);
  const eth = (window as any).ethereum;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e: any) {
    if (e?.code !== 4902) throw e;
    const addParams = add ? { ...add, chainId: hex } : { chainId: hex };
    await eth.request({ method: "wallet_addEthereumChain", params: [addParams] });
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  }
}
function bpsToPct(bps: number) { return (bps / 100).toFixed(0) + "%"; }
function baseSepoliaAddrLink(addr: string) { return `https://sepolia.basescan.org/address/${addr}`; }

/** ===== ENV (client) ===== */
const IRIS_BASE = (process.env.NEXT_PUBLIC_IRIS_BASE || "https://iris-api-sandbox.circle.com/v2").replace(/\/+$/,"");
const FINALITY = Number(process.env.NEXT_PUBLIC_FINALITY_THRESHOLD || 1000);
const TOKEN_ID = Number(process.env.NEXT_PUBLIC_TICKET_TOKEN_ID || 1);
const QTY = Number(process.env.NEXT_PUBLIC_TICKET_QTY || 1);
const MEMO_FIXED = String(process.env.NEXT_PUBLIC_MEMO || "gatee");
const EVENT_NAME = process.env.NEXT_PUBLIC_EVENT_NAME || "Gatee Fest 2025";
const TICKET_TITLE = process.env.NEXT_PUBLIC_TICKET_TITLE || "Concert Pass — Base Sepolia";

const SPLIT_ADDRS = (process.env.NEXT_PUBLIC_SPLIT_ADDRS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const SPLIT_BPS = (process.env.NEXT_PUBLIC_SPLIT_BPS || "")
  .split(",")
  .map(s => Number(s.trim()))
  .filter(n => Number.isFinite(n));

const REVENUE_SPLITS = SPLIT_ADDRS.length && SPLIT_ADDRS.length === SPLIT_BPS.length
  ? SPLIT_ADDRS.map((address, i) => ({ label: i === 0 ? "Musician" : "Partner", address, bps: SPLIT_BPS[i] }))
  : [
      { label: "Musician", address: "0x20c5FA751F10c16683Cb7236A6a4D67c2Ad1782e", bps: 8000 },
      { label: "Partner",  address: "0x76619F7D9C571F41E5d2Db8B0b98839B9C50A76B", bps: 2000 },
    ];

/** ===== DEST: Base Sepolia ===== */
const DEST = {
  NAME: "Base Sepolia",
  CHAIN_ID: 84532,
  DOMAIN: 6,
  GATEE_HOOK_ADDR: (process.env.NEXT_PUBLIC_BASE_HOOK_ADDR || "").toLowerCase(),
  READ_RPC: "https://sepolia.base.org",
  EXPLORER_TX_PREFIX: "https://sepolia.basescan.org/tx/",
} as const;

/** ===== SOURCES: ETH Sepolia + Avalanche Fuji ===== */
const SRC_ETH_SEPOLIA = {
  LABEL: "Ethereum Sepolia",
  CHAIN_ID: 11155111,
  DOMAIN: 0,
  USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238".toLowerCase(),
  TOKEN_MESSENGER_V2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA".toLowerCase(),
  RPC_ADD: {
    chainName: "Sepolia",
    nativeCurrency: { name: "SepoliaETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.sepolia.org"],
    blockExplorerUrls: ["https://sepolia.etherscan.io"],
  },
  EXPLORER_TX_PREFIX: "https://sepolia.etherscan.io/tx/",
} as const;

const SRC_AVAX_FUJI = {
  LABEL: "Avalanche Fuji",
  CHAIN_ID: 43113,
  DOMAIN: 1,
  USDC: "0x5425890298aed601595a70ab815c96711a31bc65".toLowerCase(),
  TOKEN_MESSENGER_V2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA".toLowerCase(),
  RPC_ADD: {
    chainName: "Avalanche Fuji",
    nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
    rpcUrls: ["https://api.avax-test.network/ext/bc/C/rpc"],
    blockExplorerUrls: ["https://testnet.snowtrace.io"],
  },
  EXPLORER_TX_PREFIX: "https://testnet.snowtrace.io/tx/",
} as const;

const SOURCES = {
  ETH_SEPOLIA: SRC_ETH_SEPOLIA,
  AVAX_FUJI: SRC_AVAX_FUJI,
} as const;

/** ===== ABIs ===== */
const ERC20_MIN_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
];
const HOOK_READ_ABI = ["function price6(uint256) view returns (uint256)"];

/** ===== Fees (IRIS) ===== */
type FeeRow = { finalityThreshold?: number; minimumFee?: number };
async function fetchMaxFeeBps(srcDomain: number, dstDomain: number): Promise<number> {
  const r = await fetch(`${IRIS_BASE}/burn/USDC/fees/${srcDomain}/${dstDomain}`, { cache: "no-store" });
  const j = await r.json();
  const rows: FeeRow[] = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : []);
  let maxBps = 0;
  for (const row of rows) {
    const bps = Number(row?.minimumFee ?? 0);
    if (Number.isFinite(bps) && bps > maxBps) maxBps = bps;
  }
  return maxBps;
}

/** ===== IRIS Poll ===== */
type IrisMsg = { attestation?: string; message?: string; status?: string; eventNonce?: string; decodedMessage?: any; };
async function pollIrisUntilComplete(srcDomain: number, txHash: string, timeoutMs = 600_000): Promise<IrisMsg> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const url = `${IRIS_BASE}/messages/${srcDomain}?transactionHash=${txHash}`;
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json();
    const m: IrisMsg | null = j?.data?.messages?.[0] ?? j?.messages?.[0] ?? null;
    if (m && m.attestation && m.message && m.status === "complete") return m;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error("IRIS attestation not ready within timeout");
}

/** ===== UI Phases ===== */
type Phase = "idle" | "readingPrice" | "switching" | "approving" | "burning" | "waitingAtt" | "relaying" | "afterMint" | "done" | "error";

export default function Page() {
  const [srcKey, setSrcKey] = useState<keyof typeof SOURCES>("ETH_SEPOLIA");
  const SRC = SOURCES[srcKey];

  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState<string>("");

  const [infoLoading, setInfoLoading] = useState<boolean>(false);
  const [netText, setNetText] = useState<string>("");
  const [grossText, setGrossText] = useState<string>("");
  const [maxFeeBps, setMaxFeeBps] = useState<number | null>(null);

  const [srcTx, setSrcTx] = useState<string | null>(null);
  const [srcDomainAtSend, setSrcDomainAtSend] = useState<number | null>(null);
  const [attestation, setAttestation] = useState<string | null>(null);
  const [eventNonce, setEventNonce] = useState<string | null>(null);

  const [relayTx, setRelayTx] = useState<string | null>(null);
  const [processTx, setProcessTx] = useState<string | null>(null);

  const isBusy = useMemo(() => !["idle", "done", "error"].includes(phase), [phase]);

  // Auto-load net/gross/fee
  const loadInfo = useMemo(() => {
    return async () => {
      try {
        setInfoLoading(true);
        // price (net)
        const readProv = new ethers.JsonRpcProvider(DEST.READ_RPC);
        const hookReader = new ethers.Contract(DEST.GATEE_HOOK_ADDR, HOOK_READ_ABI, readProv);
        const unit: bigint = await hookReader.price6(TOKEN_ID);
        if (unit === BigInt(0)) throw new Error("Price not set for tokenId");
        const netRequired = unit * BigInt(QTY);
        setNetText(`${fmt6(netRequired)} USDC (net)`);

        // fee bps (ambil terbesar)
        const feeBps = await fetchMaxFeeBps(SRC.DOMAIN, DEST.DOMAIN);
        setMaxFeeBps(feeBps);

        // gross = ceil(net / (1 - fee/10000))
        function ceilDiv(a: bigint, b: bigint) { return (a + (b - BigInt(1))) / b; }
        const denom = BigInt(10000 - feeBps);
        const gross = denom > BigInt(0) ? ceilDiv(netRequired * BigInt(10000), denom) : netRequired;
        setGrossText(`${fmt6(gross)} USDC (gross)`);
      } catch (e: any) {
        setNetText("—");
        setGrossText("—");
        setMaxFeeBps(null);
        console.error("auto info error:", e?.message || e);
      } finally {
        setInfoLoading(false);
      }
    };
  }, [SRC.DOMAIN]);

  useEffect(() => {
    loadInfo();
  }, [loadInfo]);

  // Next steps: panggil server dgn { sourceDomain, txHash }
  useEffect(() => {
    (async () => {
      if (!srcTx || srcDomainAtSend == null) return;
      try {
        setPhase("relaying");
        setNote((s) => s + `\nRelaying on Base via server…`);
        const resp = await fetch("/api/relay-and-process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceDomain: srcDomainAtSend, txHash: srcTx }),
        });
        const raw = await resp.text();
        const data = JSON.parse(raw);
        if (!resp.ok || !data.ok) throw new Error(data?.error || `HTTP ${resp.status}`);

        if (data.relayAlreadyDone) {
          setNote((s) => s + `\nℹ️ Relay skipped (nonce already used). Proceeding to afterMint…`);
        }
        setRelayTx(data.relayTxHash || null);
        setProcessTx(data.processTxHash || null);
        setPhase("done");
        setNote((s) => s + `\n✅ Ticket NFT received on Base!`);
      } catch (err: any) {
        console.error(err);
        setPhase("error");
        setNote((s) => s + `\n❌ Next steps error (server): ${err?.message ?? String(err)}`);
      }
    })();
  }, [srcTx, srcDomainAtSend]);

  const buyNow = async () => {
    setPhase("idle");
    setNote("");
    setSrcTx(null);
    setAttestation(null);
    setEventNonce(null);
    setRelayTx(null);
    setProcessTx(null);

    try {
      if (!DEST.GATEE_HOOK_ADDR) throw new Error("Missing NEXT_PUBLIC_BASE_HOOK_ADDR");
      if (!(window as any).ethereum) { alert("Please install MetaMask"); return; }

      // 1) switch to SOURCE
      setPhase("switching");
      setNote((s) => s + `Switching to ${SRC.LABEL}…`);
      await ensureChain(SRC.CHAIN_ID, SRC.RPC_ADD);
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();
      const buyer = (await signer.getAddress()).toLowerCase();

      // 2) compute net + fees
      setPhase("approving");
      setNote((s) => s + `\nApproving USDC…`);
      const readProv = new ethers.JsonRpcProvider(DEST.READ_RPC);
      const hookReader = new ethers.Contract(DEST.GATEE_HOOK_ADDR, HOOK_READ_ABI, readProv);
      const unit: bigint = await hookReader.price6(TOKEN_ID);
      const netRequired = unit * BigInt(QTY);
      const feeBps = await fetchMaxFeeBps(SRC.DOMAIN, DEST.DOMAIN);
      function ceilDiv(a: bigint, b: bigint) { return (a + (b - BigInt(1))) / b; }
      const denom = BigInt(10000 - feeBps);
      const grossToBurn = denom > BigInt(0) ? ceilDiv(netRequired * BigInt(10000), denom) : netRequired;
      const maxFeeCap = grossToBurn - netRequired;

      const usdc = new ethers.Contract(SRC.USDC, ERC20_MIN_ABI, signer);
      const allowance: bigint = await usdc.allowance(buyer, SRC.TOKEN_MESSENGER_V2);
      if (allowance < grossToBurn) {
        const txApprove = await usdc.approve(SRC.TOKEN_MESSENGER_V2, grossToBurn);
        await txApprove.wait();
      }

      // 3) depositForBurnWithHook (FAST)
      setPhase("burning");
      setNote((s) => s + `\nBurning & sending (FAST)…`);
      const tm = new ethers.Contract(
        SRC.TOKEN_MESSENGER_V2,
        ["function depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes) returns (uint64)"],
        signer
      );
      const hookData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint256", "string"],
        [buyer, BigInt(TOKEN_ID), BigInt(QTY), MEMO_FIXED]
      );
      const tx = await tm.depositForBurnWithHook(
        grossToBurn,
        DEST.DOMAIN,
        ethers.zeroPadValue(DEST.GATEE_HOOK_ADDR as `0x${string}`, 32),
        SRC.USDC,
        ethers.ZeroHash,
        maxFeeCap,
        FINALITY,  // <= dari env
        hookData
      );
      const rcp = await tx.wait();
      setSrcTx(rcp.hash);
      setSrcDomainAtSend(SRC.DOMAIN);

      // 4) IRIS (untuk display saja)
      setPhase("waitingAtt");
      setNote((s) => s + `\nWaiting for attestation…`);
      const m = await pollIrisUntilComplete(SRC.DOMAIN, rcp.hash);
      setAttestation(m.attestation || null);
      setEventNonce(m.eventNonce || m.decodedMessage?.nonce || null);
      setNote((s) => s + `\n✅ Attestation ready. Relaying on server…`);
      // Server call terjadi di effect {srcTx, srcDomainAtSend}
    } catch (err: any) {
      console.error(err);
      setPhase("error");
      setNote(`❌ ${err?.message ?? String(err)}`);
    }
  };

  const buttonLabel = useMemo(() => {
    switch (phase) {
      case "idle": return "Buy Ticket with USDC (FAST)";
      case "switching": return "Switching network…";
      case "approving": return "Approving USDC…";
      case "burning": return "Burning & sending…";
      case "waitingAtt": return "Waiting attestation…";
      case "relaying": return "Relaying on Base…";
      case "afterMint": return "Minting ticket…";
      case "done": return "Ticket received 🎟️";
      case "error": return "Try again";
      default: return "Buy";
    }
  }, [phase]);

  return (

      <div className="row justify-content-center">
        <div className="col-lg-7">
          <div className="card shadow-sm">
            <div className="card-body">
              <div className="d-flex align-items-center mb-3">
                <span className="badge bg-primary me-2">Ticket</span>
                <h5 className="mb-0">{EVENT_NAME}</h5>
              </div>

              <div className="row g-3 mb-3">
                <div className="col-6">
                  <div className="border rounded p-3">
                    <div className="text-muted small">Event</div>
                    <div className="fw-semibold">{EVENT_NAME}</div>
                    <div className="small">Seat: General • Token #{TOKEN_ID}</div>
                  </div>
                </div>
                <div className="col-6">
                  <div className="border rounded p-3">
                    <div className="text-muted small">Network</div>
                    <div className="fw-semibold">{DEST.NAME}</div>
                    <div className="small">Minted on destination</div>
                  </div>
                </div>
              </div>

              <div className="mb-3">
                <label className="form-label">Pay from</label>
                <select className="form-select" value={srcKey} onChange={(e)=>setSrcKey(e.target.value as any)}>
                  {Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{v.LABEL}</option>)}
                </select>
              </div>

              <div className="row g-3 mb-3">
                <div className="col-md-4">
                  <div className="border rounded p-3 h-100">
                    <div className="text-muted small">Price (net)</div>
                    <div className="fs-5">
                      {infoLoading ? <span className="spinner-border spinner-border-sm" />
                        : netText ? <span className="badge bg-success">{netText}</span> : <span className="text-muted">—</span>}
                    </div>
                  </div>
                </div>
                <div className="col-md-4">
                  <div className="border rounded p-3 h-100">
                    <div className="text-muted small">Gross (FAST)</div>
                    <div className="fs-5">
                      {infoLoading ? <span className="spinner-border spinner-border-sm" />
                        : grossText ? <span className="badge bg-secondary">{grossText}</span> : <span className="text-muted">—</span>}
                    </div>
                  </div>
                </div>
                <div className="col-md-4">
                  <div className="border rounded p-3 h-100">
                    <div className="text-muted small">Fee bps</div>
                    <div className="fs-5">
                      {infoLoading ? <span className="spinner-border spinner-border-sm" />
                        : maxFeeBps!=null ? <span className="badge bg-info text-dark">{maxFeeBps} bps</span> : <span className="text-muted">—</span>}
                    </div>
                  </div>
                </div>
              </div>

              <div className="border rounded p-3 mb-3">
                <div className="d-flex align-items-center mb-2">
                  <span className="badge bg-dark me-2">Revenue Split</span>
                  <span className="text-muted small">USDC proceeds split automatically on Base</span>
                </div>
                <ul className="list-unstyled mb-0">
                  {REVENUE_SPLITS.map((s, i) => (
                    <li key={i} className="d-flex align-items-center justify-content-between py-1">
                      <div>
                        <span className="fw-semibold">{s.label}</span>{" "}
                        <a className="text-decoration-underline small" href={baseSepoliaAddrLink(s.address)} target="_blank">
                          {s.address}
                        </a>
                      </div>
                      <span className="badge bg-secondary">{bpsToPct(s.bps)}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <button
                onClick={buyNow}
                disabled={isBusy}
                className="btn btn-primary w-100 d-flex align-items-center justify-content-center"
              >
                {isBusy && <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>}
                {buttonLabel}
              </button>

              <div className="mt-3">
                <ul className="list-group">
                  <li className="list-group-item d-flex justify-content-between align-items-center">
                    1) Burn & send (source)
                    <span className={`badge ${srcTx ? "bg-success" : isBusy ? "bg-warning text-dark" : "bg-secondary"}`}>
                      {srcTx ? "done" : isBusy ? "working" : "idle"}
                    </span>
                  </li>
                  <li className="list-group-item d-flex justify-content-between align-items-center">
                    2) Attestation (IRIS)
                    <span className={`badge ${attestation ? "bg-success" : phase==="waitingAtt" ? "bg-warning text-dark" : "bg-secondary"}`}>
                      {attestation ? "ready" : phase==="waitingAtt" ? "waiting" : "idle"}
                    </span>
                  </li>
                  <li className="list-group-item d-flex justify-content-between align-items-center">
                    3) Relay on Base
                    <span className={`badge ${relayTx || phase==="done" ? "bg-success" : phase==="relaying" ? "bg-warning text-dark" : "bg-secondary"}`}>
                      {relayTx ? "relayed" : phase==="relaying" ? "relaying" : phase==="done" ? "ok" : "idle"}
                    </span>
                  </li>
                  <li className="list-group-item d-flex justify-content-between align-items-center">
                    4) Mint Ticket
                    <span className={`badge ${processTx || phase==="done" ? "bg-success" : phase==="afterMint" ? "bg-warning text-dark" : "bg-secondary"}`}>
                      {processTx ? "minted" : phase==="afterMint" ? "minting" : phase==="done" ? "minted" : "idle"}
                    </span>
                  </li>
                </ul>
              </div>

              {note && (
                <pre className="bg-light p-3 rounded small mt-3" style={{whiteSpace:"pre-wrap"}}>{note}</pre>
              )}

              <div className="mt-3 small">
                {srcTx && <div>Source tx: <a href={`${SOURCES[srcKey].EXPLORER_TX_PREFIX}${srcTx}`} target="_blank" className="link-primary">{srcTx}</a></div>}
                {relayTx && <div>Relay tx: <a href={`${DEST.EXPLORER_TX_PREFIX}${relayTx}`} target="_blank" className="link-primary">{relayTx}</a></div>}
                {processTx && <div>processAfterMint tx: <a href={`${DEST.EXPLORER_TX_PREFIX}${processTx}`} target="_blank" className="link-primary">{processTx}</a></div>}
                {eventNonce && <div className="mt-2"><span className="badge bg-dark">nonce</span> <code className="small">{eventNonce}</code></div>}
              </div>
            </div>
          </div>

          <p className="text-center text-muted small mt-3">
            Powered by CCTP (FAST) • Destination: {DEST.NAME}
          </p>
        </div>
      </div>
  );
}

