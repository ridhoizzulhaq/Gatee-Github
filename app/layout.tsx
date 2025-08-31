// app/layout.tsx
import type { Metadata } from "next";
import Script from "next/script";
import "bootstrap/dist/css/bootstrap.min.css";

export const metadata: Metadata = {
  title: "Gatee",
  description: "USDC ticketing on Base Sepolia",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-bs-theme="light"> 
      <body className="bg-white">
     
        <nav className="navbar navbar-light bg-white border-bottom sticky-top">
          <div className="container">
            <a className="navbar-brand fw-bold" href="/">Gatee</a>
            <a href="/tickets" className="btn btn-outline-primary">My Tickets</a>
          </div>
        </nav>

        <main>{children}</main>

      
        <Script
          src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}