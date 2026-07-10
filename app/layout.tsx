import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LabSync — AI powered sustainable experiment scheduling",
  description:
    "LabSync merges lab schedules to reduce reagent waste, hazardous disposal, and energy use. A scheduling copilot for sustainable wet labs.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
