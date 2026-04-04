import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 32,
          height: 32,
          background: "#0E0F0F",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 18,
          fontWeight: 700,
          color: "#C9A84C",
          letterSpacing: "-0.5px",
        }}
      >
        8.
      </div>
    ),
    { width: 32, height: 32 }
  );
}
