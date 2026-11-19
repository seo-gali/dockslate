export { backend } from './ipc/client';
export type * from './ipc/contracts/core';
export { useBackendQuery, useContainerMetrics, updateContainerStatus, refreshDashboard, refreshDashboardAfterMutation, refreshDockerChanges, useDockerEvents } from './queries';
