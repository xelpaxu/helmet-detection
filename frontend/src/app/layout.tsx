import type { Metadata } from "next";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "./globals.css";
export const metadata: Metadata = { title: "Helmet Watch | Traffic monitoring", description: "Live traffic monitoring, incident evidence, and recording review." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" data-theme="dark" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: "try{document.documentElement.dataset.theme=localStorage.getItem('helmet-watch-theme')==='light'?'light':'dark'}catch{}" }} /></head><body>{children}</body></html>;
}
