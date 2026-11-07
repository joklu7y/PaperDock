#define AppName "PaperDock"
#define AppVersion "1.1.1"
#define AppPublisher "PaperDock"
#define AppExeName "PaperDock.exe"

[Setup]
#ifdef TestInstall
AppId=PaperDock-InstallationSmokeTest
#else
AppId={{8E81F1CB-1E1B-4E00-9A6C-B599A612D61B}
#endif
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
#ifdef TestInstall
DefaultDirName={src}\..\installation-smoke-test
DefaultGroupName=PaperDock Test
#else
DefaultDirName={localappdata}\Programs\PaperDock
DefaultGroupName=PaperDock
#endif
OutputDir=..\installer-output
#ifdef TestInstall
OutputBaseFilename=PaperDock-Test
Compression=none
#else
OutputBaseFilename=PaperDock-Setup-{#AppVersion}
Compression=lzma2
#endif
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
UninstallDisplayIcon={app}\{#AppExeName}

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "..\desktop-release\PaperDock\*"; DestDir: "{app}"; Excludes: "PaperDockData\*"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\PaperDock"; Filename: "{app}\{#AppExeName}"
Name: "{group}\卸载 PaperDock"; Filename: "{uninstallexe}"
Name: "{autodesktop}\PaperDock"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "启动 PaperDock"; Flags: nowait postinstall skipifsilent
