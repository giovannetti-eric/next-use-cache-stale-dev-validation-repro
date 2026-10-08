import type { ReactNode } from "react";
import { Banner } from "./banner";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Banner />
        {children}
      </body>
    </html>
  );
}
