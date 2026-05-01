export const metadata = {
  title: "TokSuan × Next.js example",
  description: "Minimal chat UI proxied through the TokSuan gateway",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
