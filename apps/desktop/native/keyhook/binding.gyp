{
  "targets": [
    {
      "target_name": "keyhook",
      "sources": ["src/keyhook.cc"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "UNICODE", "_UNICODE"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 0
        }
      },
      "conditions": [
        ["OS=='win'", { "libraries": ["-luser32"] }]
      ]
    }
  ]
}
