
# Gatee

Gatee is a blockchain ticketing platform that uses Circle’s Cross Chain Transfer Protocol (CCTP) to accept canonical USDC payments across networks. It automatically handles revenue splits, issues ERC1155 voucher NFTs as tickets, and stores metadata on IPFS. Users access a simple ticket dashboard that displays balances, details, and rotating QR codes for secure on-site validation.

Note : For now, Gatee supports transfers from Avalanche Sepolia and Ethereum Sepolia to its contract on Base Sepolia.

## Run Next.JS project

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```



## .ENV Configuration
```bash
# ========= Server (Base Sepolia) =========
BASE_RPC=https://sepolia.base.org
BASE_RELAYER_PRIVATE_KEY= (With with your Contract Relayer Private Key)
BASE_MT_PROXY=0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275
BASE_HOOK_ADDR=0x7ed7f37EfAaCAbE1A40854eEc29b00cFED333E9d
BASE_DEST_DOMAIN=6
AFTERMINT_DELAY_MS=5000

# ========= Client (public) =========
NEXT_PUBLIC_BASE_HOOK_ADDR=0x7ed7f37EfAaCAbE1A40854eEc29b00cFED333E9d
NEXT_PUBLIC_VOUCHER_1155=0x0831b0B193FB2b771566c30bc65BAD8c9E62afa3
NEXT_PUBLIC_IRIS_BASE=https://iris-api-sandbox.circle.com/v2
NEXT_PUBLIC_FINALITY_THRESHOLD=1000

# Ticket config
NEXT_PUBLIC_TICKET_TOKEN_ID=1
NEXT_PUBLIC_TICKET_QTY=1
NEXT_PUBLIC_MEMO=gatee

NEXT_PUBLIC_EVENT_NAME="Gatee Fest 2025"
NEXT_PUBLIC_TICKET_TITLE="Concert Pass — Base Sepolia"


NEXT_PUBLIC_SPLIT_ADDRS=0x20c5FA751F10c16683Cb7236A6a4D67c2Ad1782e,0x76619F7D9C571F41E5d2Db8B0b98839B9C50A76B
NEXT_PUBLIC_SPLIT_BPS=8000,2000
```

## MVP link, Github, Contract, and Documentation

Vercel :
https://gatee-github-jet.vercel.app/

Documentation :
https://gatee.hashnode.space/

Github :
https://github.com/ridhoizzulhaq/Gatee-Github

GateHookSplitPriced :

https://base-sepolia.blockscout.com/address/0x7ed7f37EfAaCAbE1A40854eEc29b00cFED333E9d?tab=contract

ERC-1155 :

https://base-sepolia.blockscout.com/address/0x0831b0B193FB2b771566c30bc65BAD8c9E62afa3?tab=contract