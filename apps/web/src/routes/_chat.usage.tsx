import { createFileRoute } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";

export type UsageRouteSearch = {
  readonly metric?: "cost" | "tokens" | "limits" | "reviews" | undefined;
};

export const Route = createFileRoute("/_chat/usage")({
  validateSearch: (raw: Record<string, unknown>): UsageRouteSearch => {
    const metric =
      raw.metric === "cost" ||
      raw.metric === "tokens" ||
      raw.metric === "limits" ||
      raw.metric === "reviews"
        ? (raw.metric as "cost" | "tokens" | "limits" | "reviews")
        : undefined;
    return metric ? { metric } : {};
  },
  component: UsagePage,
});
