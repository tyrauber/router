import {
  PathConfig,
  PathConfigMap,
  validatePathConfig,
} from "@react-navigation/core";
import type {
  NavigationState,
  PartialState,
  Route,
} from "@react-navigation/routers";
import * as queryString from "query-string";

import {
  matchDeepDynamicRouteName,
  matchDynamicName,
  matchFragmentName,
} from "../matchers";

type Options<ParamList extends object> = {
  initialRouteName?: string;
  screens: PathConfigMap<ParamList>;
};

export type State =
  | NavigationState
  | Omit<PartialState<NavigationState>, "stale">;

type StringifyConfig = Record<string, (value: any) => string>;

type ConfigItem = {
  pattern?: string;
  stringify?: StringifyConfig;
  screens?: Record<string, ConfigItem>;
  // Used as fallback for fragments
  initialRouteName?: string;
};

type CustomRoute = Route<string> & {
  state?: State;
};

const getActiveRoute = (state: State): { name: string; params?: object } => {
  const route =
    typeof state.index === "number"
      ? state.routes[state.index]
      : state.routes[state.routes.length - 1];

  if (route.state) {
    return getActiveRoute(route.state);
  }

  if (route && isInvalidParams(route.params)) {
    return getActiveRoute(createFakeState(route.params));
  }

  return route;
};

function createFakeState(params: StateAsParams) {
  return {
    stale: false,
    type: "UNKNOWN",
    key: "UNKNOWN",
    index: 0,
    routeNames: [],
    routes: [
      {
        key: "UNKNOWN",
        name: params.screen,
        params: params.params,
        path: params.path,
      },
    ],
  };
}

function segmentMatchesConvention(segment: string): boolean {
  return (
    segment === "index" ||
    matchDynamicName(segment) != null ||
    matchFragmentName(segment) != null ||
    matchDeepDynamicRouteName(segment) != null
  );
}

function encodeURIComponentPreservingBrackets(str: string) {
  return encodeURIComponent(str).replace(/%5B/g, "[").replace(/%5D/g, "]");
}

/**
 * Utility to serialize a navigation state object to a path string.
 *
 * @example
 * ```js
 * getPathFromState(
 *   {
 *     routes: [
 *       {
 *         name: 'Chat',
 *         params: { author: 'Jane', id: 42 },
 *       },
 *     ],
 *   },
 *   {
 *     screens: {
 *       Chat: {
 *         path: 'chat/:author/:id',
 *         stringify: { author: author => author.toLowerCase() }
 *       }
 *     }
 *   }
 * )
 * ```
 *
 * @param state Navigation state to serialize.
 * @param options Extra options to fine-tune how to serialize the path.
 * @returns Path representing the state, e.g. /foo/bar?count=42.
 */
export default function getPathFromState<ParamList extends object>(
  state: State,
  // @ts-expect-error: non-standard options
  _options?: Options<ParamList> & {
    preserveFragments?: boolean;
    preserveDynamicRoutes?: boolean;
  } = {}
): string {
  if (state == null) {
    throw Error(
      "Got 'undefined' for the navigation state. You must pass a valid state object."
    );
  }

  const { preserveFragments, preserveDynamicRoutes, ...options } = _options;

  if (_options) {
    validatePathConfig(options);
  }

  const screens = options?.screens;
  // Expo Router disallows usage without a linking config.
  if (!screens) {
    throw Error(
      "You must pass a 'screens' object to 'getPathFromState' to generate a path."
    );
  }

  return getPathFromResolvedState(
    state,
    // Create a normalized configs object which will be easier to use
    createNormalizedConfigs(screens),
    { preserveFragments, preserveDynamicRoutes }
  );
}

function processParamsWithUserSettings(
  configItem: ConfigItem,
  params: Record<string, any>
) {
  const stringify = configItem?.stringify;

  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      // TODO: Strip nullish values here.
      stringify?.[key] ? stringify[key](value) : String(value),
    ])
  );
}

function deepEqual(a: any, b: any) {
  if (a === b) {
    return true;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }

    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }

    return true;
  }

  if (typeof a === "object" && typeof b === "object") {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);

    if (keysA.length !== keysB.length) {
      return false;
    }

    for (const key of keysA) {
      if (!deepEqual(a[key], b[key])) {
        return false;
      }
    }

    return true;
  }

  return false;
}

function walkConfigItems(
  route: CustomRoute,
  focusedRoute: {
    name: string;
    params?: object;
  },
  configs: Record<string, ConfigItem>
) {
  // NOTE(EvanBacon): Fill in current route using state that was passed as params.
  if (!route.state && isInvalidParams(route.params)) {
    route.state = createFakeState(route.params);
  }

  let pattern: string | null = null;
  let focusedParams: Record<string, any> | undefined;

  const collectedParams: Record<string, any> = {};

  while (route.name in configs) {
    const configItem = configs[route.name];
    const inputPattern = configItem.pattern;

    if (inputPattern == null) {
      // This should never happen in Expo Router.
      throw new Error("Unexpected: No pattern found for route " + route.name);
    }
    pattern = inputPattern;

    if (route.params) {
      const params = processParamsWithUserSettings(configItem, route.params);

      // TODO: Does this need to be a null check?
      if (pattern) {
        Object.assign(collectedParams, params);
      }
      if (deepEqual(focusedRoute, route)) {
        // If this is the focused route, keep the params for later use
        // We save it here since it's been stringified already
        focusedParams = getParamsWithConventionsCollapsed({
          params,
          pattern,
          routeName: route.name,
        });
      }
    }

    if (!route.state && isInvalidParams(route.params)) {
      route.state = createFakeState(route.params);
    }

    // If there is no `screens` property or no nested state, we return pattern
    if (!configItem.screens || route.state === undefined) {
      if (
        configItem.initialRouteName &&
        configItem.screens &&
        configItem.initialRouteName in configItem.screens &&
        configItem.screens[configItem.initialRouteName]?.pattern
      ) {
        const initialRouteConfig =
          configItem.screens[configItem.initialRouteName];

        // NOTE(EvanBacon): Big hack to support initial route changes in tab bars.
        pattern = initialRouteConfig.pattern!;

        if (focusedParams) {
          // If this is the focused route, keep the params for later use
          // We save it here since it's been stringified already
          focusedParams = getParamsWithConventionsCollapsed({
            params: focusedParams,
            pattern,
            routeName: route.name,
          });
        }
      }
      break;
    }

    const index = route.state.index ?? route.state.routes.length - 1;

    const nextRoute = route.state.routes[index];
    const nestedScreens = configItem.screens;

    // if there is config for next route name, we go deeper
    if (nestedScreens && nextRoute.name in nestedScreens) {
      route = nextRoute as CustomRoute;
      configs = nestedScreens;
    } else {
      // If not, there is no sense in going deeper in config
      break;
    }
  }

  if (pattern && !focusedParams && focusedRoute.params) {
    // If this is the focused route, keep the params for later use
    // We save it here since it's been stringified already
    focusedParams = getParamsWithConventionsCollapsed({
      params: focusedRoute.params,
      pattern,
      routeName: route.name,
    });
    Object.assign(focusedParams, collectedParams);
  }

  if (pattern == null) {
    throw new Error(
      `No pattern found for route "${route.name}". Options are: ${Object.keys(
        configs
      ).join(", ")}.`
    );
  }

  return {
    pattern,
    nextRoute: route,
    focusedParams,
    params: collectedParams,
  };
}

function getPathFromResolvedState(
  state: State,
  configs: Record<string, ConfigItem>,
  {
    preserveFragments,
    preserveDynamicRoutes,
  }: { preserveFragments?: boolean; preserveDynamicRoutes?: boolean }
) {
  let path = "";
  let current: State = state;

  const allParams: Record<string, any> = {};

  while (current) {
    path += "/";

    const route = current.routes[current.index ?? 0] as CustomRoute;
    // NOTE(EvanBacon): Fill in current route using state that was passed as params.
    // if (isInvalidParams(route.params)) {
    if (!route.state && isInvalidParams(route.params)) {
      route.state = createFakeState(route.params);
    }

    const { pattern, params, nextRoute, focusedParams } = walkConfigItems(
      route,
      getActiveRoute(current),
      { ...configs }
    );

    Object.assign(allParams, params);

    path += getPathWithConventionsCollapsed({
      pattern,
      routePath: nextRoute.path,
      params: allParams,
      initialRouteName: configs[nextRoute.name]?.initialRouteName,
      preserveFragments,
      preserveDynamicRoutes,
    });

    if (nextRoute.state) {
      // Continue looping with the next state if available.
      current = nextRoute.state;
    } else {
      // Finished crawling state.

      const outputParams = preserveDynamicRoutes ? params : focusedParams;
      // Check for query params before exiting.
      if (outputParams) {
        for (const param in outputParams) {
          // TODO: This is not good. We shouldn't squat strings named "undefined".
          if (outputParams[param] === "undefined") {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete outputParams[param];
          }
        }

        const query = queryString.stringify(outputParams, { sort: false });

        if (query) {
          path += `?${query}`;
        }
      }
      break;
    }
  }
  return basicSanitizePath(path);
}

function getPathWithConventionsCollapsed({
  pattern,
  routePath,
  params,
  preserveFragments,
  preserveDynamicRoutes,
  initialRouteName,
}: {
  pattern: string;
  routePath?: string;
  params: Record<string, any>;
  preserveFragments?: boolean;
  preserveDynamicRoutes?: boolean;
  initialRouteName?: string;
}) {
  const segments = pattern.split("/");
  return segments
    .map((p, i) => {
      const name = getParamName(p);

      // We don't know what to show for wildcard patterns
      // Showing the route name seems ok, though whatever we show here will be incorrect
      // Since the page doesn't actually exist
      if (p === "*") {
        if (i === 0) {
          // This can occur when a wildcard matches all routes and the given path was `/`.
          return routePath;
        }
        // remove existing segments from route.path and return it
        // this is used for nested wildcard routes. Without this, the path would add
        // all nested segments to the beginning of the wildcard route.
        return routePath
          ?.split("/")
          .slice(i + 1)
          .join("/");
      }

      // If the path has a pattern for a param, put the param in the path
      if (p.startsWith(":")) {
        if (preserveDynamicRoutes) {
          return `[${name}]`;
        }
        // Optional params without value assigned in route.params should be ignored
        return params[name];
      }

      if (!preserveFragments && matchFragmentName(p) != null) {
        // When the last part is a fragment it could be a shared URL
        // if the route has an initialRouteName defined, then we should
        // use that as the component path as we can assume it will be shown.
        if (segments.length - 1 === i) {
          if (initialRouteName) {
            // Return an empty string if the init route is ambiguous.
            if (segmentMatchesConvention(initialRouteName)) {
              return "";
            }
            return encodeURIComponentPreservingBrackets(initialRouteName);
          }
        }
        return "";
      }
      // Preserve dynamic syntax for rehydration
      return encodeURIComponentPreservingBrackets(p);
    })
    .map((v) => v ?? "")
    .join("/");
}

/** Given a set of query params and a pattern with possible conventions, collapse the conventions and return the remaining params. */
function getParamsWithConventionsCollapsed({
  pattern,
  routeName,
  params,
}: {
  pattern: string;
  /** Route name is required for matching the wildcard route. This is specific to Expo Router. */
  routeName: string;
  params: object;
}): Record<string, string> {
  const processedParams = { ...params };

  // Remove the params present in the pattern since we'll only use the rest for query string

  const segments = pattern.split("/");

  // Dynamic Routes
  segments
    .filter((segment) => segment.startsWith(":"))
    .forEach((segment) => {
      const name = getParamName(segment);
      delete processedParams[name];
    });

  // Deep Dynamic Routes
  if (segments.some((segment) => segment === "*")) {
    // NOTE(EvanBacon): Drop the param name matching the wildcard route name -- this is specific to Expo Router.
    const name = matchDeepDynamicRouteName(routeName) ?? routeName;
    delete processedParams[name];
  }

  return processedParams;
}

// Remove multiple as well as trailing slashes
function basicSanitizePath(path: string) {
  // Remove duplicate slashes like `foo//bar` -> `foo/bar`
  const simplifiedPath = path.replace(/\/+/g, "/");
  if (simplifiedPath.length <= 1) {
    return simplifiedPath;
  }
  // Remove trailing slash like `foo/bar/` -> `foo/bar`
  return simplifiedPath.replace(/\/$/, "");
}

type StateAsParams = {
  initial: boolean;
  path?: string;
  screen: string;
  params: Record<string, any>;
};

// TODO: Make StackRouter not do this...
// Detect if the params came from StackRouter using `params` to pass around internal state.
function isInvalidParams(
  params?: Record<string, any>
): params is StateAsParams {
  if (!params) {
    return false;
  }

  if (
    "params" in params &&
    typeof params.params === "object" &&
    !!params.params
  ) {
    return true;
  }

  return (
    "initial" in params &&
    typeof params.initial === "boolean" &&
    // "path" in params &&
    "screen" in params
  );
}

const getParamName = (pattern: string) =>
  pattern.replace(/^:/, "").replace(/\?$/, "");

const joinPaths = (...paths: string[]): string =>
  ([] as string[])
    .concat(...paths.map((p) => p.split("/")))
    .filter(Boolean)
    .join("/");

const createConfigItem = (
  config: PathConfig<object> | string,
  parentPattern?: string
): ConfigItem => {
  if (typeof config === "string") {
    // If a string is specified as the value of the key(e.g. Foo: '/path'), use it as the pattern
    const pattern = parentPattern ? joinPaths(parentPattern, config) : config;

    return { pattern };
  }

  if (config.exact && config.path === undefined) {
    throw new Error(
      "A 'path' needs to be specified when specifying 'exact: true'. If you don't want this screen in the URL, specify it as empty string, e.g. `path: ''`."
    );
  }

  // If an object is specified as the value (e.g. Foo: { ... }),
  // It can have `path` property and `screens` prop which has nested configs
  const pattern =
    config.exact !== true
      ? joinPaths(parentPattern || "", config.path || "")
      : config.path || "";

  const screens = config.screens
    ? createNormalizedConfigs(config.screens, pattern)
    : undefined;

  return {
    // Normalize pattern to remove any leading, trailing slashes, duplicate slashes etc.
    pattern: pattern?.split("/").filter(Boolean).join("/"),
    stringify: config.stringify,
    screens,
    initialRouteName: config.initialRouteName,
  };
};

const createNormalizedConfigs = (
  options: PathConfigMap<object>,
  pattern?: string
): Record<string, ConfigItem> =>
  Object.fromEntries(
    Object.entries(options).map(([name, c]) => [
      name,
      createConfigItem(c, pattern),
    ])
  );
