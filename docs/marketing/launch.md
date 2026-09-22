# BG0 organic launch

Budget: $0. Audience hypothesis: people who repeatedly prepare product images.
Success means returning to complete another removal, not just opening a page.

## Ready-to-publish copy

These are drafts, not published posts. Verify the deployed remover and new
routes before using them. No ads, paid listings, outreach automation, or new
subscriptions are part of this launch.

### Short announcement

BG0 removes image backgrounds in your browser. Your images stay on your device.

Free, unlimited, open source, and no account needed. Choose an image and download
a transparent PNG: https://bg0.dev

The first use downloads the model. Processing speed depends on your device.

### Product listing

Name: BG0

Tagline: Free background removal, without uploading your images.

Description: BG0 is an open-source background remover that processes images
locally in your browser. Choose, drop, or paste an image, inspect the result, and
download a transparent PNG. No account, subscription, or usage credits. The
browser downloads a model before processing; performance varies by device.

Website: https://bg0.dev

Source: https://github.com/opencoredev/bg0

Price: Free

Categories: Image tools, background removal, open source

### Product-photo demonstration script

Use a redistributable product photo whose license permits the demonstration.
Record the real interface. Do not simulate speed or hide a processing failure.

1. Show the original product image and say: "I need a cutout for a product design."
2. Open BG0 and choose the image. Say: "BG0 processes this on my device."
3. Show progress. If the recording skips waiting, label the cut explicitly.
4. Inspect the edges in the preview, then download the PNG.
5. End with: "Free background removal. No account. bg0.dev."

## Release and distribution queue

Owner: the agent handling the launch. This is an execution record, not homework
for Leo. External account access and approval apply at the point of publishing.

| Work | State | Completion evidence |
| --- | --- | --- |
| Three search entry pages and homepage links | Implemented locally | Build and browser verification |
| Canonicals, page descriptions, social metadata, sitemap | Implemented locally | Rendered metadata and sitemap checks |
| Deploy the reviewed changes | Pending | New URLs return 200 on bg0.dev |
| Google Search Console sitemap submission | Pending account access | Verified property and accepted sitemap |
| Free AlternativeTo listing | Draft ready; not submitted | Public listing URL; check free submission terms first |
| Founder announcement | Draft ready; not posted | Approved post and public URL |
| Product demonstration | Script ready; not recorded | Licensed fixture and real recording |
| Baseline and retention dashboard | Specification below; not configured | Saved report and baseline counts |

Do not create accounts, pay directory fees, or publish in communities without
checking their current rules. Use a few relevant placements and record their
URLs. Do not mass-submit or repeat unsolicited messages.

## Measurement using existing events

The app already emits `image_selected`, `background_removal_succeeded`, and
`$pageview`. Inspect `apps/web/src/lib/analytics.ts` for the download event before
configuring reports. Do not change the image-data boundary for marketing.

Create a funnel from image selection to successful removal to download, with a
30-minute conversion window. Compare weekly counts and conversion rates. Keep
pageviews as a separate discovery metric.

Create a retention report whose first and returning event are both
`background_removal_succeeded`. Report whether an anonymous browser returns on
a later day within 7 and 30 days. Use only cohorts old enough to have the entire
window. Report raw counts beside percentages; early small cohorts are noisy.
Local-storage identifiers count browsers, not people, and resets lose continuity.

Review Search Console impressions, clicks, indexed pages, and queries once a week
after deployment. Improve the page matching queries that produce useful visits.
Allow several weeks for indexing; publishing pages does not guarantee rankings.
Do not create near-duplicate pages to inflate page count.

Every two weeks, use the observed errors and funnel drop-offs to choose one
improvement. If visits rise but successful removals do not, fix that workflow
before expanding distribution. If successful users return, expand the relevant
use-case content with real examples.
