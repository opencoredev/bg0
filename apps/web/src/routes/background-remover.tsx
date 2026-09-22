import { createFileRoute } from "@tanstack/react-router";
import { SeoLandingPage, landingHead } from "#/components/seo-landing-page";

const DESCRIPTION =
  "Remove an image background for free in your browser. BG0 runs locally, keeps your image on your device, and exports a transparent PNG.";

export const Route = createFileRoute("/background-remover")({
  head: () =>
    landingHead("Free background remover", DESCRIPTION, "/background-remover"),
  component: BackgroundRemoverPage,
});

function BackgroundRemoverPage() {
  return (
    <SeoLandingPage
      title="Free background remover"
      intro="Remove the background from a photo and download a transparent PNG. BG0 processes your image on your device, with no account, credits, or subscription."
      steps={[
        "Open the remover and choose or drop an image. PNG, JPG, WebP, HEIC, and HEIF files up to 40 MB are supported.",
        "Keep the page open while BG0 prepares the model and processes your image. The first use needs an internet connection to download the model.",
        "Inspect the result, then select Download PNG. Choose another image when you are ready to repeat the process.",
      ]}
      points={[
        {
          title: "Your photo stays on your device",
          body: "BG0 downloads the model to your browser and runs it there. It does not upload your image, filename, thumbnail, or generated mask to a processing service.",
        },
        {
          title: "What to expect on your first visit",
          body: "Downloading and preparing the model takes time. Processing speed depends on your device and browser, so allow the progress indicator to finish before closing the page.",
        },
        {
          title: "Returning to BG0",
          body: "Your browser can cache the model for later visits. Clearing site data, private browsing, or browser storage eviction can mean another download. Bookmark BG0 to find it when you need the next cutout.",
        },
        {
          title: "Check before you download",
          body: "Automatic removal can miss fine edges or parts of the subject. Compare the result with your original. If the cutout loses detail you need, try a photo with clearer separation between the subject and its background.",
        },
      ]}
      related={[
        { href: "/transparent-png", label: "Make a transparent PNG" },
        {
          href: "/product-photo-background-remover",
          label: "Remove product photo backgrounds",
        },
      ]}
    />
  );
}
