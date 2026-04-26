import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
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
				<script
					dangerouslySetInnerHTML={{
						__html: `
          (function() {
            var theme = localStorage.getItem('8gent-debugger-theme');
            if (theme === 'dark') document.documentElement.classList.add('dark');
            else if (theme === 'light') document.documentElement.classList.remove('dark');
            else if (window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('dark');
          })();
        `,
					}}
				/>
			</head>
			<body className={`${geistMono.variable} font-mono antialiased`}>
				{children}
			</body>
		</html>
	);
}
