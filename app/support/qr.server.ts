import QRCode from "qrcode";

/**
 * Render one donation address as an inline SVG QR code, entirely on the
 * server with the vendored `qrcode` package: no third-party QR service, no
 * remote image, and no visitor input ever reaches this function. The caller
 * only passes a parsed `SUPPORT_*_ADDRESS` value from `donations.ts`, and the
 * library emits geometry only (no echoed text), so the string is injected as
 * trusted generated markup.
 */
export async function renderQrSvg(data: string): Promise<string> {
  return QRCode.toString(data, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
  });
}
