import nodePolyfills  from 'rollup-plugin-node-polyfills';
import json           from '@rollup/plugin-json';

export default {
  input: 'src/main.js',
  output: [
    {
      file: 'dist/garagedoor.js',
      format: 'cjs'
    },
  ],
  plugins: [
    nodePolyfills(),
    json()
  ]
};
