import { createFileRoute } from "@tanstack/react-router";
import { SeoLandingPage, landingHead } from "#/components/seo-landing-page";

const DESCRIPTION =
  "Remove product photo backgrounds for free in your browser. Download a transparent PNG, check the product edges, and prepare it for your listing or design.";

export const Route = createFileRoute("/product-photo-background-remover")({
  head: () =>
    landingHead(
      "Product photo background remover",
      DESCRIPTION,
      "/product-photo-background-remover",
    ),
  component: ProductPhotoPage,
});

function ProductPhotoPage() {
  return (
    <SeoLandingPage
      title="Product photo background remover"
      intro="Cut a product out of its photo for a storefront, catalog, or design. BG0 processes each image in your browser and exports a transparent PNG. Your source photo stays on your device."
      steps={[
        "Choose a sharp photo with the entire product visible. A simple background that differs from the product makes the edges easier to judge.",
        "Open the photo in BG0 and wait for removal. Compare the result with the original, checking handles, straps, labels, and small protruding parts.",
        "Download the PNG. Check your destination requirements, then use a design tool if you need a solid background, different crop, or specific export size.",
      ]}
      points={[
        {
          title: "Protect the details buyers need",
          body: "Look for clipped corners, missing holes, leftover background, and changes around packaging text. Reflective or transparent products need extra care. A cutout should still show the actual shape and condition of the item.",
        },
        {
          title: "Check the listing requirements",
          body: "A transparent PNG is a starting point, not a guarantee that a marketplace will accept the image. Check its current background, size, file format, and framing requirements before publishing.",
        },
        {
          title: "Keep a consistent set of photos",
          body: "Use similar lighting and camera angles across your source photos. Background removal does not fix blur, lighting, or perspective, and BG0 does not add a white backdrop or arrange products on a canvas.",
        },
        {
          title: "Repeat for the next product",
          body: "Save your downloaded PNG, then choose another image. Keep the originals so you can compare details or try a different shot. The local remover has no account requirement or usage quota.",
        },
      ]}
      related={[
        {
          href: "/background-remover",
          label: "Use the general background remover",
        },
        { href: "/transparent-png", label: "Learn about transparent PNGs" },
      ]}
    />
  );
}
