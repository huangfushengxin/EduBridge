import {
  createContext,
  useContext,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";

interface ParsedLocation {
  path: string;
  query: URLSearchParams;
}

function getLocation(): ParsedLocation {
  const hash = window.location.hash;
  let raw = hash.startsWith("#/") ? hash.slice(1) : hash;
  if (!raw || raw === "/" || raw === "#") raw = "/";
  const qIndex = raw.indexOf("?");
  const path = (qIndex >= 0 ? raw.slice(0, qIndex) : raw) || "/";
  const query = new URLSearchParams(qIndex >= 0 ? raw.slice(qIndex + 1) : "");
  return { path, query };
}

interface RouterValue {
  path: string;
  query: URLSearchParams;
  navigate: (to: string) => void;
}

const RouterContext = createContext<RouterValue>({
  path: "/",
  query: new URLSearchParams(),
  navigate: () => {},
});

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<ParsedLocation>(getLocation);

  useEffect(() => {
    const onChange = () => {
      setLocation(getLocation());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = (to: string) => {
    window.location.hash = to;
  };

  return (
    <RouterContext.Provider value={{ path: location.path, query: location.query, navigate }}>
      {children}
    </RouterContext.Provider>
  );
}

export function useRouter(): RouterValue {
  return useContext(RouterContext);
}

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  children: ReactNode;
}

export function Link({ to, children, ...rest }: LinkProps) {
  return (
    <a href={`#${to}`} {...rest}>
      {children}
    </a>
  );
}
