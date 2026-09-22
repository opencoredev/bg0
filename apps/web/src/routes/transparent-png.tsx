import { createFileRoute } from "@tanstack/react-router";
import { SeoLandingPage, landingHead } from "#/components/seo-landing-page";

const DESCRIPTION =
  "Make a transparent PNG from a photo for free. Remove its background locally with BG0, then check and download the cutout for your design.";

export const Route = createFileRoute("/transparent-png")({
  head: () =>
    landingHead("Make a transparent PNG", DESCRIPTION, "/transparent-png"),
  component: TransparentPngPage,
});

function TransparentPngPage() {
  return (
    <SeoLandingPage
      title="Make a transparent PNG"
      intro="A transparent PNG lets the background of your page or design show through around a subject. Use BG0 to remove a photo's background and save the result as a PNG, without uploading the photo."
      steps={[
        "Open BG0 and choose your source photo. Renaming a JPG file to .png will not remove its background.",
        "Wait for processing and inspect the cutout. Select Download PNG to save the result with transparency.",
        "Place the downloaded file over a colored background in your design tool. Check the edges and any gaps inside the subject before using it.",
      ]}
      points={[
        {
          title: "White is still a background",
          body: "A white area in an image is not necessarily transparent. A viewer may also display transparent areas as white. Place the PNG over a different color to see whether that color shows through.",
        },
        {
          title: "What the checkerboard means",
          body: "Image tools often use a checkerboard to show transparency. Download the PNG rather than taking a screenshot of its preview, because a screenshot can turn the checkerboard into visible pixels.",
        },
        {
          title: "Keep the file as PNG",
          body: "JPEG does not support transparency. Converting your cutout to JPG fills the transparent areas with a background color. Keep a PNG copy if you want to reuse the cutout over different backgrounds.",
        },
        {
          title: "Review fine details",
          body: "Hair, fur, glass, and soft shadows can be difficult to separate from a background. Inspect those areas on both light and dark backgrounds. BG0 removes backgrounds automatically and does not include a manual touch-up editor.",
        },
      ]}
      related={[
        {
          href: "/background-remover",
          label: "Use the free background remover",
        },
        {
          href: "/product-photo-background-remover",
          label: "Prepare a product photo",
        },
      ]}
    />
  );
}
