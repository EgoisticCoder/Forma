import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "FORMA — Your code can see the page now.",
  description: "An open coding agent with a fine-tuned visual auditor and a browser toolbox for fixing the UI you actually ship.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
