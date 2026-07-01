"use client";

import { ExternalLink, ThumbsDown, ThumbsUp } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { gitConfig } from "@/lib/shared";

type FeedbackOpinion = "good" | "bad";

type FeedbackProps = {
  pageTitle: string;
};

export function Feedback({ pageTitle }: FeedbackProps) {
  const messageId = useId();
  const [opinion, setOpinion] = useState<FeedbackOpinion | null>(null);
  const [message, setMessage] = useState("");

  function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const title = `Docs feedback: ${pageTitle}`;
    const pagePath = window.location.pathname;
    const body = [
      `Page: ${pagePath}`,
      `Opinion: ${opinion === "good" ? "Good" : "Needs work"}`,
      "",
      message.trim() || "No additional notes.",
    ].join("\n");
    const url = new URL(`https://github.com/${gitConfig.user}/${gitConfig.repo}/issues/new`);
    url.searchParams.set("title", title);
    url.searchParams.set("body", body);

    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }

  return (
    <section className="mt-12 border-t border-fd-border pt-6">
      <fieldset className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <legend className="text-sm font-medium text-fd-foreground">Was this page useful?</legend>
        <div className="flex gap-2">
          <button
            type="button"
            aria-pressed={opinion === "good"}
            onClick={() => setOpinion("good")}
            className="inline-flex items-center gap-2 rounded-md border border-fd-border bg-fd-background px-3 py-2 text-sm text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground aria-pressed:border-fd-primary aria-pressed:text-fd-primary"
          >
            <ThumbsUp className="size-4" aria-hidden="true" />
            Good
          </button>
          <button
            type="button"
            aria-pressed={opinion === "bad"}
            onClick={() => setOpinion("bad")}
            className="inline-flex items-center gap-2 rounded-md border border-fd-border bg-fd-background px-3 py-2 text-sm text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground aria-pressed:border-fd-primary aria-pressed:text-fd-primary"
          >
            <ThumbsDown className="size-4" aria-hidden="true" />
            Needs work
          </button>
        </div>
      </fieldset>
      {opinion ? (
        <form className="mt-4 space-y-3" onSubmit={submitFeedback}>
          <label htmlFor={messageId} className="text-sm font-medium text-fd-foreground">
            What should we know?
          </label>
          <textarea
            id={messageId}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={3}
            className="block w-full resize-y rounded-md border border-fd-border bg-fd-background px-3 py-2 text-sm text-fd-foreground outline-none transition-colors placeholder:text-fd-muted-foreground focus:border-fd-primary"
            placeholder="Share what worked or what was confusing."
          />
          <button
            type="submit"
            className="inline-flex items-center gap-2 rounded-md bg-fd-primary px-3 py-2 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring"
          >
            Open GitHub issue
            <ExternalLink className="size-4" aria-hidden="true" />
          </button>
        </form>
      ) : null}
    </section>
  );
}
