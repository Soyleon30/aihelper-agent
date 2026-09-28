const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_workspace',
      description: '返回当前默认工作区绝对路径。相对路径的 list/read/write 都相对此目录。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        '列出本地目录。path 可省略（=工作区）；相对路径相对配置的 workspace，勿写到安装目录。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '目录路径；相对路径相对 workspace；空则列出 workspace'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取本地文本文件。相对路径相对 workspace。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（相对=工作区）' },
          encoding: { type: 'string', description: '编码，默认 utf8' },
          maxBytes: { type: 'number', description: '最大读取字节数' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        '写入本地文件。相对路径相对 workspace（如 notes.txt → 工作区/notes.txt），禁止写到安装目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（相对=工作区）' },
          content: { type: 'string', description: '文件内容' },
          encoding: { type: 'string', description: '编码，默认 utf8' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: '追加内容到本地文件。相对路径相对 workspace。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_path',
      description: '删除文件或空目录。相对路径相对 workspace。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description: '发送 HTTP 请求（GET/POST/PUT/DELETE/PATCH），可用于 API 或网页表单 POST。下载大文件请用 download_file。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string', description: 'GET/POST/PUT/DELETE/PATCH' },
          headers: { type: 'object', description: '请求头键值对' },
          body: { type: 'string', description: '请求体字符串' },
          json: { type: 'object', description: '若提供则作为 JSON body' },
          form: { type: 'object', description: 'application/x-www-form-urlencoded 表单' },
          timeoutMs: { type: 'number' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'download_file',
      description:
        '下载文件到配置的下载目录（可用 path/dir/filename 指定位置与名称）。同名默认改名 file(1).ext；skipIfExists=true 才跳过；force/overwrite 才覆盖。返回本地绝对路径。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '文件 URL' },
          filename: { type: 'string', description: '可选保存文件名' },
          path: { type: 'string', description: '可选完整保存路径（优先于 dir+filename）' },
          dir: { type: 'string', description: '可选保存目录（与 filename 配合）' },
          skipIfExists: {
            type: 'boolean',
            description: '默认 false：同名改名；true 则跳过'
          },
          force: { type: 'boolean', description: 'true 则强制覆盖/重新下载' },
          timeoutMs: { type: 'number' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'download_from_markdown',
      description:
        '从 Markdown 文本或 md 文件中提取链接并批量下载。自动去重，已下载的 URL 会跳过。',
      parameters: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: 'md 正文' },
          path: { type: 'string', description: '本地 md 文件路径' },
          extensions: {
            type: 'array',
            items: { type: 'string' },
            description: '只下这些后缀，如 [\"pdf\",\"zip\",\"docx\"]'
          },
          filter: { type: 'string', description: 'URL 正则过滤' },
          skipIfExists: { type: 'boolean' },
          force: { type: 'boolean' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_downloads',
      description: '列出下载目录中的文件',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_download_dir',
      description: '返回当前配置的下载目录绝对路径',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_test',
      description:
        '检测本机 Coremail 客户端/网页会话是否可用（不使用 IMAP/POP3，只读）',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_launch_client',
      description: '启动本机已安装的 Coremail 客户端程序（需配置 exePath）',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_list_folders',
      description: '从 Coremail 界面侧栏尝试列出文件夹名称',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_list',
      description:
        '通过本机 Coremail 客户端/已登录网页列出邮件（非 IMAP）。返回 id/index/subject/from。',
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: '文件夹名，如 收件箱' },
          limit: { type: 'number', description: '条数，默认 20，最大 50' },
          unseenOnly: { type: 'boolean', description: '仅未读（尽力）' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_search',
      description: '在 Coremail 界面搜索框搜索邮件（非 IMAP）',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          from: { type: 'string' },
          subject: { type: 'string' },
          limit: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_read',
      description:
        '打开并读取 Coremail 邮件：正文取 .mail-content 内 iframe 的 p 段，收发件人取 #rc_from。返回 subject/from/to/text。用 mail_list 的 index 或 id。只读不发送。',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '列表序号，从 1 起' },
          id: { type: 'string', description: '列表返回的 id' },
          uid: { type: 'number', description: '兼容旧参数，等同 index' },
          maxChars: { type: 'number', description: '正文最大字符，默认 15000' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_state',
      description:
        '查看当前浏览器会话（本机可见 Chrome 窗口）：是否打开、URL/标题/正文预览、downloadDir、recentDownloads。用户手操后继续任务时先调本工具，再在当前页 click/type，勿轻易重新 navigate。感知靠 DOM 文本，不是截图循环。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description:
        '打开或跳转浏览器页面（本机可见窗口，默认本机 Chrome）。若 browser_state 已在目标站，优先在当前页继续，勿重复打开。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          waitUntil: { type: 'string', description: 'load|domcontentloaded|networkidle' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description:
        '点击页面元素（CSS 选择器或文本）。text/selector 必须来自用户指令或本轮 browser_get_text 看到的真实控件，禁止瞎点导航栏「日志」「查询」「首页」等。下载优先 browser_download；waitDownload=true 可等落盘，并可传 filename/path/dir。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器' },
          text: {
            type: 'string',
            description: '可见文本（与 selector 二选一）；须与用户要操作的按钮一致，勿用无关词'
          },
          timeoutMs: { type: 'number' },
          force: {
            type: 'boolean',
            description: '仅控制 Playwright 强制点击，不影响下载是否覆盖'
          },
          waitDownload: {
            type: 'boolean',
            description: 'true=等待本次点击触发的下载完成并返回 path（下完再落盘/改名）'
          },
          downloadTimeoutMs: { type: 'number', description: '等下载超时，默认 12000' },
          filename: { type: 'string', description: 'waitDownload 时可选保存名' },
          path: { type: 'string', description: 'waitDownload 时可选完整保存路径' },
          dir: { type: 'string', description: 'waitDownload 时可选保存目录' },
          skipIfExists: {
            type: 'boolean',
            description: 'waitDownload 时默认 false：同名改名 file(1).ext；true 才跳过'
          },
          overwrite: {
            type: 'boolean',
            description: 'waitDownload 时 true=覆盖同名（与点击 force 无关）'
          },
          downloadForce: {
            type: 'boolean',
            description: '同 overwrite，显式强制覆盖下载文件'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait_download',
      description:
        '等待下一次浏览器内下载完成。同时监听 Playwright 事件与 .aihelper-incoming 落盘；文件写稳后自动搬到下载目录并同名改名。返回绝对路径。',
      parameters: {
        type: 'object',
        properties: {
          timeoutMs: { type: 'number', description: '超时毫秒，默认 12000' },
          filename: { type: 'string' },
          path: { type: 'string' },
          dir: { type: 'string' },
          skipIfExists: { type: 'boolean', description: '默认 false：同名改名' },
          overwrite: { type: 'boolean' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_list_downloads',
      description: '列出本会话近期浏览器下载记录（路径、文件名、URL）',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多条数，默认 20' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_resolve_download_url',
      description:
        '从当前页解析真实下载 URL：读 a[href]/data-url，或点击后拦截网络。只返回 url，不落盘。拿到 url 后用 download_file 或 browser_download。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
          url: { type: 'string', description: '若已知直接传入' },
          click: { type: 'boolean', description: '默认 true：找不到 href 时点击并拦网络' },
          timeoutMs: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_download',
      description:
        '【推荐】点页面下载按钮/链接并落盘。可用 filename/path/dir 指定保存位置与名称；同名默认改名 file(1).ext。参数 selector/text 或 url；返回 path。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
          url: { type: 'string' },
          filename: { type: 'string' },
          path: { type: 'string' },
          dir: { type: 'string' },
          skipIfExists: {
            type: 'boolean',
            description: '默认 false：同名改名；true 才跳过'
          },
          force: { type: 'boolean', description: 'true 则覆盖同名文件（等同 overwrite）' },
          overwrite: { type: 'boolean', description: 'true 则覆盖同名文件' },
          click: { type: 'boolean', description: '无 href 时是否点击解析，默认 true' },
          timeoutMs: { type: 'number' },
          fallbackPlaywright: {
            type: 'boolean',
            description: 'HTTP 解析失败时是否回退 Playwright download，默认 true'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_record_start',
      description:
        '开始录制用户在浏览器中的点击/输入。请先打开目标页，再调用本工具，然后人工操作；结束后 browser_record_stop。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '流程名，默认 flow-时间戳' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_record_stop',
      description:
        '结束录制并保存为流程 JSON（userData/flows）。输入内容默认变量化成 {{变量}}，回放时用 vars 覆盖。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '可选保存路径' },
          detectVariables: { type: 'boolean', description: '是否自动把输入标成变量，默认 true' },
          variables: { type: 'object', description: '可选：预设/覆盖变量示例值' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_record_status',
      description: '查看当前是否在录制及已录步骤数',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_flow_list',
      description: '列出已保存的操作流程（录制产物）',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_flow_run',
      description:
        '按录制流程回放。vars 覆盖变量，例如 {"应用名":"bsdmp","日志路径":"/app/log"}。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '流程名（flows 目录下）' },
          path: { type: 'string', description: '流程 JSON 路径' },
          vars: {
            type: 'object',
            description: '变量键值，替换步骤中的 {{key}}'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: '在输入框中输入文字',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
          clear: { type: 'boolean', description: '输入前是否清空' },
          pressEnter: { type: 'boolean', description: '输入后是否回车' }
        },
        required: ['selector', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_fill_form',
      description: '批量填写表单字段',
      parameters: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                selector: { type: 'string' },
                value: { type: 'string' }
              },
              required: ['selector', 'value']
            }
          }
        },
        required: ['fields']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_text',
      description:
        '获取页面或元素文本。默认含所有 iframe（Coremail 等邮件正文常在 iframe）。selector 可选。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: '可选，主页面与 iframe 内都会尝试' },
          maxChars: { type: 'number', description: '最大字符，默认 100000' },
          includeFrames: {
            type: 'boolean',
            description: '是否读取子 iframe，默认 true'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_html',
      description: '获取页面或元素 HTML（默认附带子 iframe 内容）',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          maxChars: { type: 'number' },
          includeFrames: { type: 'boolean', description: '默认 true' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description:
        '截图并保存到配置的截图目录（默认 图片/AIHelper-Screenshots）。返回 path 绝对路径。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '可选：绝对路径或相对截图目录的文件名' },
          fullPage: { type: 'boolean' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_screenshot_dir',
      description: '返回当前截图保存目录的绝对路径',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait',
      description: '等待选择器出现或固定毫秒',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          ms: { type: 'number' },
          timeoutMs: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description: '在页面执行简单 JS 表达式并返回结果（只读查询优先）',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string' }
        },
        required: ['expression']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: '关闭当前浏览器会话',
      parameters: { type: 'object', properties: {} }
    }
  }
];

module.exports = { TOOL_DEFINITIONS };
