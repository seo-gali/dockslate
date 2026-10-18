import type { Container } from './api';

const databasePorts = new Set([1433, 1521, 3306, 5432, 5672, 6379, 6380, 9042, 11211, 27017, 27018, 27019]);
export const webPort = (port: NonNullable<Container['publishedPorts']>[number]) => port.protocol === 'tcp' && !databasePorts.has(port.privatePort);
export function connectionAddress(port: NonNullable<Container['publishedPorts']>[number]): string {
  const address = `127.0.0.1:${port.publicPort}`;
  return [27017, 27018, 27019].includes(port.privatePort) && port.protocol === 'tcp' ? `mongodb://${address}/` : address;
}
