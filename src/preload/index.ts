import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('facet', { version: '0.1.0' });
