import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Northstar",
  description: "Vision system status for Huskie Robotics, FRC Team 3061",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
