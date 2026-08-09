import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { Shell } from "./components/layout.js";
import { ConfigurationRoute } from "./routes/configuration.js";
import { QueueRoute } from "./routes/queue.js";
import { ReviewRoute } from "./routes/review.js";
import { RunRoute } from "./routes/run.js";

function OperatorRoutes() {
  const queryClient = useQueryClient();
  const invalidateSnapshots = useMemo(
    () => () => {
      void queryClient.invalidateQueries({ queryKey: ["operator"] });
    },
    [queryClient],
  );

  return <Shell onSnapshot={invalidateSnapshots} />;
}

export function App() {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 5_000, retry: false } },
      }),
    [],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<OperatorRoutes />}>
            <Route index element={<Navigate to="/queue" replace />} />
            <Route path="queue" element={<QueueRoute />} />
            <Route path="runs/:runId" element={<RunRoute />} />
            <Route path="review" element={<ReviewRoute />} />
            <Route path="configuration" element={<ConfigurationRoute />} />
            <Route path="*" element={<Navigate to="/queue" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
