import {
  BoltIcon,
  ChartBarSquareIcon,
  CircleStackIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  CubeTransparentIcon,
  KeyIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import { Link, Outlet, useLocation, useMatches } from "react-router";

export function meta({}: any) {
  return [{ title: "Settings — Fabro" }];
}

export const handle = { hideHeader: true };

type NavItem = {
  type?: "link";
  name: string;
  href: string;
  icon: typeof Cog6ToothIcon;
  match: (pathname: string) => boolean;
};

type NavSection = { type: "section"; key: string; label: string };

type NavDivider = { type: "divider"; key: string };

type NavEntry = NavItem | NavSection | NavDivider;

const navItems: NavEntry[] = [
  { type: "section", key: "general", label: "General" },
  {
    name: "Models",
    href: "/settings/models",
    icon: CpuChipIcon,
    match: (p) => p === "/settings" || p.startsWith("/settings/models"),
  },
  {
    name: "Integrations",
    href: "/settings/integrations",
    icon: PuzzlePieceIcon,
    match: (p) => p.startsWith("/settings/integrations"),
  },
  {
    name: "Sandboxes",
    href: "/settings/sandboxes",
    icon: CubeTransparentIcon,
    match: (p) => p.startsWith("/settings/sandboxes"),
  },
  {
    name: "Security",
    href: "/settings/security",
    icon: ShieldCheckIcon,
    match: (p) => p.startsWith("/settings/security"),
  },
  {
    name: "Secrets",
    href: "/settings/secrets",
    icon: KeyIcon,
    match: (p) => p.startsWith("/settings/secrets"),
  },
  { type: "section", key: "administration", label: "Administration" },
  {
    name: "Server",
    href: "/settings/server",
    icon: Cog6ToothIcon,
    match: (p) => p.startsWith("/settings/server"),
  },
  {
    name: "Storage",
    href: "/settings/storage",
    icon: CircleStackIcon,
    match: (p) => p.startsWith("/settings/storage"),
  },
  {
    name: "Monitoring",
    href: "/settings/monitoring",
    icon: ChartBarSquareIcon,
    match: (p) => p.startsWith("/settings/monitoring"),
  },
  { type: "divider", key: "after-administration" },
  {
    name: "Live Events",
    href: "/settings/live-events",
    icon: BoltIcon,
    match: (p) => p.startsWith("/settings/live-events"),
  },
];

function isLink(entry: NavEntry): entry is NavItem {
  return entry.type !== "divider" && entry.type !== "section";
}

function classNames(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export default function SettingsLayout() {
  const { pathname } = useLocation();
  const matches = useMatches();
  const currentName =
    navItems.filter(isLink).find((item) => item.match(pathname))?.name ?? "Settings";
  const fullHeight = matches.some(
    (m) => (m.handle as { fullHeight?: boolean } | undefined)?.fullHeight,
  );

  return (
    <div
      className={classNames(
        "flex flex-col gap-6 lg:flex-row",
        fullHeight && "min-h-0 flex-1",
      )}
    >
      <aside className="lg:w-56 lg:shrink-0">
        <nav className="sticky top-6">
          <ul role="list" className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-0.5">
            {navItems.map((entry) => {
              if (entry.type === "divider") {
                return (
                  <li
                    key={entry.key}
                    role="separator"
                    aria-orientation="vertical"
                    className="mx-1 self-stretch border-l border-line lg:mx-0 lg:my-2 lg:self-auto lg:border-l-0 lg:border-t"
                  />
                );
              }
              if (entry.type === "section") {
                return (
                  <li
                    key={entry.key}
                    className="hidden lg:block lg:px-2.5 lg:pt-4 lg:pb-1 lg:text-xs lg:font-medium lg:uppercase lg:tracking-wider lg:text-fg-muted first:lg:pt-0"
                  >
                    {entry.label}
                  </li>
                );
              }
              const current = entry.match(pathname);
              return (
                <li key={entry.name}>
                  <Link
                    to={entry.href}
                    aria-current={current ? "page" : undefined}
                    className={classNames(
                      "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm whitespace-nowrap transition-colors",
                      current
                        ? "bg-overlay text-fg"
                        : "text-fg-3 hover:bg-overlay hover:text-fg",
                    )}
                  >
                    <entry.icon className="size-4 shrink-0" aria-hidden="true" />
                    {entry.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      <div
        className={classNames(
          "min-w-0 flex-1",
          fullHeight && "flex min-h-0 flex-col",
        )}
      >
        <h1 className="mb-2 text-xl font-semibold tracking-tight text-fg">
          {currentName}
        </h1>
        <Outlet />
      </div>
    </div>
  );
}
