import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

export const metadata: Metadata = {
	title: "8gent Debugger",
	description: "Live session inspector for 8gent-code",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				{/* Theme bootstrap loads before hydration to prevent flash. Static file, no runtime input. */}
				<Script src="/theme-init.js" strategy="beforeInteractive" />
			</head>
			<body className={`${geistMono.variable} font-mono antialiased`}>{children}</body>
		</html>
	);
}
