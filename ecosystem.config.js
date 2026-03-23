module.exports = {
  apps: [
    {
      name: 'trump-btc',
      script: 'dist/main.js',
      watch: false,           // KHÔNG watch file - tránh restart khi ghi data/posts.json
      node_args: '--max-old-space-size=1024',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
