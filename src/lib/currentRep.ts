import { RemAndType } from './types';

let currentRemAndType: RemAndType | null | undefined = undefined;
export const getCurrentRemAndType = () => currentRemAndType;
export const setCurrentRemAndType = (remAndType: RemAndType | null | undefined) => {
  currentRemAndType = remAndType;
};
