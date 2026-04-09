import sys
sys.stdout.reconfigure(encoding='utf-8')

# Read the fragment
with open(r'C:\src\remote-copilot-mcp\proc_gen_fragment.ts', 'r', encoding='utf-8') as f:
    fragment = f.read()

# Read the existing reflection.ts
with open(r'C:\src\remote-copilot-mcp\src\data\memory\reflection.ts', 'r', encoding='utf-8') as f:
    content = f.read()

if 'PROCEDURE_SYSTEM_PROMPT' in content:
    print('Already present, nothing to do')
    sys.exit(0)

# Append the fragment
content = content.rstrip() + '\n' + fragment

with open(r'C:\src\remote-copilot-mcp\src\data\memory\reflection.ts', 'w', encoding='utf-8') as f:
    f.write(content)

lines = content.count('\n') + 1
print(f'Done. reflection.ts now has {lines} lines')
