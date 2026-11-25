import { defineConfig } from "vitepress";
import llmstxt from "vitepress-plugin-llms";

const repo = "https://github.com/Prestgg1/qala";

export default defineConfig({
  title: "Qala",
  description: "A structured TypeScript backend framework that compiles to a native binary",
  base: "/qala/",
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ["orm.md"],
  // Writes /llms.txt (page index) and /llms-full.txt (all docs in one file) at build time, plus a .md copy of every page.
  vite: { plugins: [llmstxt({ domain: "https://prestgg1.github.io" })] },
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/qala/logo.svg" }]],
  themeConfig: {
    logo: "/logo.svg",
    search: { provider: "local" },
    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: "Edit this page on GitHub",
    },
    socialLinks: [{ icon: "github", link: repo }],
    nav: [
      { text: "Guide", link: "/guide/introduction" },
      { text: "Native builds", link: "/guide/native" },
      { text: "Performance", link: "/guide/performance" },
    ],
    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "What is Qala", link: "/guide/introduction" },
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "Project layout", link: "/guide/project-layout" },
        ],
      },
      {
        text: "Essentials",
        items: [
          { text: "Controllers", link: "/guide/controllers" },
          { text: "Resources", link: "/guide/resources" },
          { text: "Responses", link: "/guide/responses" },
          { text: "Models", link: "/guide/models" },
          { text: "Migrations", link: "/guide/migrations" },
          { text: "Queries", link: "/guide/queries" },
        ],
      },
      {
        text: "Building apps",
        items: [
          { text: "Dependency injection", link: "/guide/dependency-injection" },
          { text: "Authentication", link: "/guide/auth" },
          { text: "Errors", link: "/guide/errors" },
          { text: "Events", link: "/guide/events" },
          { text: "Config", link: "/guide/config" },
          { text: "Testing", link: "/guide/testing" },
          { text: "OpenAPI", link: "/guide/openapi" },
        ],
      },
      {
        text: "Native builds",
        items: [
          { text: "Writing code for scriptc", link: "/guide/native" },
          { text: "Deployment", link: "/guide/deployment" },
          { text: "qala check", link: "/guide/check" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Performance", link: "/guide/performance" },
          { text: "Example app", link: "/guide/example-app" },
        ],
      },
    ],
    footer: { message: "Released under the MIT License.", copyright: "Qala" },
  },
});
