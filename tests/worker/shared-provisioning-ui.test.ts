import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, it } from "vitest";

import { SharedProvisioning } from "../../app/sharing/SharedProvisioning";

it("reports provisioning busy before the initial fetcher effect has run", () => {
  const router = createMemoryRouter([{ path: "/", Component: SharedProvisioning }]);
  try {
    // Rendering without effects reproduces the first client render: the fetcher
    // is idle, but no provisioning result (or route-module readiness) exists yet.
    const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
    expect(html).toContain('aria-label="Shared access provisioning"');
    expect(html).toContain('aria-busy="true"');
  } finally {
    router.dispose();
  }
});
