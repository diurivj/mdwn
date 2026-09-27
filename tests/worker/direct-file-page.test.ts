import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routerState = vi.hoisted(() => ({
  fetcherState: "idle" as string,
  fetcherData: null as unknown,
  revalidatorState: "idle" as string,
  navigationState: "idle" as string,
  revalidate: vi.fn(),
}));

vi.mock("react-router", async () => {
  const { createElement } = await import("react");
  const Form = (props: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("form", props as never, props.children);
  const Link = (props: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("a", props as never, props.children);
  return {
    Link,
    useFetcher: () => ({ state: routerState.fetcherState, data: routerState.fetcherData, Form }),
    useNavigation: () => ({ state: routerState.navigationState }),
    useRevalidator: () => ({ state: routerState.revalidatorState, revalidate: routerState.revalidate }),
  };
});

import { DirectFilePage } from "../../app/tree/DirectFilePage";

const fileId = "018f0000-0000-7000-8000-000000000601";
const renderProvisioning = (targetId = fileId) => renderToStaticMarkup(createElement(DirectFilePage, {
  fileId: targetId, initial: { status: "provisioning", snapshot: null },
}));

beforeEach(() => {
  routerState.fetcherState = "idle";
  routerState.fetcherData = null;
  routerState.revalidatorState = "idle";
  routerState.navigationState = "idle";
  routerState.revalidate.mockClear();
});

describe("nameless direct File provisioning page", () => {
  it("offers only an explicit resource retry with the validated File id and intent", () => {
    const html = renderProvisioning();

    expect(html).toContain("Shared content is being securely provisioned");
    expect(html).toContain('action="/resources/sharing"');
    expect(html).toContain('name="intent" value="provision-direct-file"');
    expect(html).toContain(`name="fileId" value="${fileId}"`);
    expect(html.match(/type="hidden"/g)).toHaveLength(2);
    expect(html).toContain("Retry secure access");
    expect(html).not.toContain("Owner");
    expect(html).not.toContain("Shared as");
  });

  it("keeps the retry pending and disabled while the action or route revalidation is busy", () => {
    routerState.fetcherState = "submitting";
    const submitting = renderProvisioning();
    expect(submitting).toContain("Checking secure access");
    expect(submitting).toContain("disabled=\"\"");

    routerState.fetcherState = "idle";
    routerState.revalidatorState = "loading";
    const revalidating = renderProvisioning();
    expect(revalidating).toContain("Checking secure access");
    expect(revalidating).toContain("disabled=\"\"");
  });

  it("never renders a retry form for a non-UUIDv7 target", () => {
    const html = renderProvisioning("../../private-name");
    expect(html).toContain("Shared content is being securely provisioned");
    expect(html).not.toContain("<form");
  });
});
