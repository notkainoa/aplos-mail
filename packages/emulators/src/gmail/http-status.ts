const TEXT: Record<number, string> = {
  200: 'OK',
  204: 'No Content',
  302: 'Found',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export const statusText = (status: number): string => TEXT[status] ?? 'Unknown';
