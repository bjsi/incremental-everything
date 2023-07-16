export const tryParseJson = (x: any) => {
  try {
    return JSON.parse(x);
  } catch (e) {
    return undefined;
  }
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
