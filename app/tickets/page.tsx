"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import QRCode from "qrcode"; // npm i qrcode

/** ====== CONFIG ====== */
const BASE_RPC = "https://sepolia.base.org";
const BASE_EXPLORER = "https://sepolia.basescan.org";
const CHAIN_ID = 84532; // Base Sepolia
const VOUCHER_1155 = (process.env.NEXT_PUBLIC_VOUCHER_1155 || "").toLowerCase();

const CANDIDATE_IDS = [1]; 

// Durasi QR hidup (detik)
const QR_LIFETIME = 25;

/** ====== ABIs (minimal read) ====== */
const ERC1155_MIN_ABI = [
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function uri(uint256 id) view returns (string)",
];

/** ====== Helpers ====== */
function toHexUnpadded(n: number) { return "0x" + n.toString(16); }

async function ensureBaseSepolia() {
  const eth = (window as any).ethereum;
  const hex = toHexUnpadded(CHAIN_ID);
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e: any) {
    if (e?.code !== 4902) throw e;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: hex,
        chainName: "Base Sepolia",
        rpcUrls: [BASE_RPC],
        nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
        blockExplorerUrls: [BASE_EXPLORER],
      }],
    });
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  }
}

function idToUriHex(id: number | bigint) {
  // ERC-1155 spec: {id} diganti 64-hex lowercase (tanpa 0x)
  const hex = (BigInt(id).toString(16)).padStart(64, "0");
  return hex;
}

function ipfsToHttp(u: string) {
  if (!u) return u;
  if (u.startsWith("ipfs://")) {
    const path = u.replace("ipfs://", "");
    return `https://ipfs.io/ipfs/${path}`;
  }
  return u;
}

async function fetchJson(url: string) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Fetch ${url} -> ${r.status}`);
  return await r.json();
}

type TicketMeta = {
  name?: string;
  description?: string;
  image?: string;
  attributes?: Array<{ trait_type?: string; value?: any }>;
};

type CardTicket = {
  id: number;
  balance: bigint;
  meta?: TicketMeta;
  imageUrl?: string;
  loadingMeta: boolean;
  qrDataUrl?: string;
  qrExpiresAt?: number;
  lastSig?: string;
  countdown?: number;
};

export default function Page() {
  const [addr, setAddr] = useState<string>("");
  const [items, setItems] = useState<CardTicket[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorText, setErrorText] = useState<string>("");

  const countdownTimers = useRef<Record<number, any>>({}); // per tokenId
  const rotateTimers = useRef<Record<number, any>>({});    // per tokenId

  const hasVoucher = useMemo(() => ethers.isAddress(VOUCHER_1155), []);

  useEffect(() => {
    (async () => {
      try {
        if (!hasVoucher) throw new Error("NEXT_PUBLIC_VOUCHER_1155 belum di-set.");
        if (!(window as any).ethereum) throw new Error("Please install MetaMask");

        await ensureBaseSepolia();
        const provider = new ethers.BrowserProvider((window as any).ethereum);
        const signer = await provider.getSigner();
        const me = (await signer.getAddress()).toLowerCase();
        setAddr(me);

        const readProv = new ethers.JsonRpcProvider(BASE_RPC);
        const voucher = new ethers.Contract(VOUCHER_1155, ERC1155_MIN_ABI, readProv);

        const next: CardTicket[] = [];
        for (const id of CANDIDATE_IDS) {
          let bal: bigint = BigInt(0);
          try {
            bal = await voucher.balanceOf(me, id);
          } catch { /* ignore */ }
          if (bal > BigInt(0)) {
            // fetch uri + metadata
            let uri = "";
            try {
              uri = await voucher.uri(id);
            } catch { /* ignore */ }

            let resolved = uri;
            if (uri && uri.includes("{id}")) {
              resolved = uri.replace("{id}", idToUriHex(id));
            }
            resolved = ipfsToHttp(resolved);

            let meta: TicketMeta | undefined = undefined;
            let imageUrl: string | undefined = undefined;
            let loadingMeta = true;

            if (resolved) {
              try {
                meta = await fetchJson(resolved);
                imageUrl = ipfsToHttp(meta?.image || "");
                loadingMeta = false;
              } catch {
                loadingMeta = false;
              }
            } else {
              loadingMeta = false;
            }

            next.push({ id, balance: bal, meta, imageUrl, loadingMeta });
          }
        }

        setItems(next);
      } catch (e: any) {
        console.error(e);
        setErrorText(e?.message || String(e));
      } finally {
        setLoading(false);
      }
    })();

    return () => {
      // bersihkan timer saat unmount
      Object.values(countdownTimers.current).forEach(clearInterval);
      Object.values(rotateTimers.current).forEach(clearInterval);
    };
  }, [hasVoucher]);

  async function makeQrFor(id: number) {
    try {
      // rotasi QR: nonce random + expiry singkat
      const eth = (window as any).ethereum;
      const provider = new ethers.BrowserProvider(eth);
      const signer = await provider.getSigner();
      const owner = (await signer.getAddress()).toLowerCase();

      const now = Math.floor(Date.now() / 1000);
      const exp = now + QR_LIFETIME;
      // nonce random 16 byte
      const nonce = ethers.hexlify(ethers.randomBytes(16));

      // Pesan sederhana (EIP-191 personal_sign). Di gate, server:
      // - recoverAddress(message, signature) == owner
      // - now <= exp
      // - balanceOf(owner, id) >= 1  (read-only)
      const message = `GateeCheck|owner:${owner}|id:${id}|qty:1|nonce:${nonce}|exp:${exp}|chainId:${CHAIN_ID}|voucher:${VOUCHER_1155}`;

      const signature = await signer.signMessage(message);

      const payload = {
        type: "gate_check",
        owner,
        id,
        qty: 1,
        nonce,
        exp,
        chainId: CHAIN_ID,
        voucher: VOUCHER_1155,
        message,
        signature,
      };

      const dataUrl = await QRCode.toDataURL(JSON.stringify(payload));

      // simpan ke card
      setItems(curr =>
        curr.map(it => it.id === id ? { ...it, qrDataUrl: dataUrl, lastSig: signature, qrExpiresAt: exp, countdown: QR_LIFETIME } : it)
      );

      // countdown per card
      if (countdownTimers.current[id]) clearInterval(countdownTimers.current[id]);
      countdownTimers.current[id] = setInterval(() => {
        setItems(curr => curr.map(it => {
          if (it.id !== id) return it;
          const c = (it.countdown ?? 0) - 1;
          return { ...it, countdown: c > 0 ? c : 0 };
        }));
      }, 1000);

      // auto-rotate per card (buat QR baru menjelang kadaluarsa)
      if (rotateTimers.current[id]) clearInterval(rotateTimers.current[id]);
      rotateTimers.current[id] = setInterval(() => {
        makeQrFor(id).catch(() => {});
      }, (QR_LIFETIME - 2) * 1000);

    } catch (e: any) {
      console.error(e);
      alert(e?.message || String(e));
    }
  }

  if (loading) {
    return (
      <main className="container py-4" style={{ maxWidth: 920 }}>
        <h4>My Tickets</h4>
        <div className="text-muted">Loading your tickets…</div>
      </main>
    );
  }

  if (errorText) {
    return (
      <main className="container py-4" style={{ maxWidth: 920 }}>
        <h4>My Tickets</h4>
        <div className="alert alert-danger">{errorText}</div>
      </main>
    );
  }

  return (
    <main className="container py-4" style={{ maxWidth: 1024 }}>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="m-0">My Tickets</h4>
        {addr && (
          <a
            className="btn btn-sm btn-outline-dark"
            href={`${BASE_EXPLORER}/address/${addr}`}
            target="_blank"
            rel="noreferrer"
          >
            {addr.slice(0, 6)}…{addr.slice(-4)}
          </a>
        )}
      </div>

      {items.length === 0 ? (
        <div className="alert alert-secondary">You don’t hold any of the configured ticket IDs on Base Sepolia.</div>
      ) : (
        <div className="row g-3">
          {items.map((it) => (
            <div className="col-12 col-sm-6 col-lg-4" key={it.id}>
              <div className="card h-100 shadow-sm">
                {it.imageUrl ? (
                  <img src={it.imageUrl} className="card-img-top" alt={it.meta?.name || `Ticket #${it.id}`} />
                ) : (
                  <div className="bg-light" style={{ height: 180 }} />
                )}

                <div className="card-body d-flex flex-column">
                  <h5 className="card-title mb-1">{it.meta?.name || `Ticket #${it.id}`}</h5>
                  <div className="small text-muted mb-2">Token ID: {it.id} · Owned: {it.balance.toString()}</div>
                  {it.meta?.description && (
                    <p className="card-text small">{it.meta.description}</p>
                  )}
                  {it.meta?.attributes?.length ? (
                    <div className="mb-2">
                      {it.meta.attributes.slice(0, 4).map((a, i) => (
                        <span key={i} className="badge text-bg-light me-1 mb-1">
                          {a.trait_type || "attr"}: {String(a.value)}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-auto">
                    <div className="d-flex align-items-center gap-2">
                      <button
                        className="btn btn-dark btn-sm"
                        onClick={() => makeQrFor(it.id)}
                      >
                        {it.qrDataUrl ? "Refresh QR" : "Show QR"}
                      </button>
                      <a
                        className="btn btn-outline-secondary btn-sm"
                        href={`${BASE_EXPLORER}/token/${VOUCHER_1155}?a=${addr}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View on Explorer
                      </a>
                    </div>

                    {it.qrDataUrl && (
                      <div className="mt-3 text-center">
                        <img
                          src={it.qrDataUrl}
                          alt={`QR ticket ${it.id}`}
                          style={{ width: 220, height: 220 }}
                        />
                        <div className="small text-muted mt-1">
                          Expires in <b>{it.countdown ?? 0}s</b>
                        </div>
                        <details className="small mt-2">
                          <summary>QR payload (debug)</summary>
                          <div className="text-break small">
                            Signature: <code>{it.lastSig}</code>
                          </div>
                        </details>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}