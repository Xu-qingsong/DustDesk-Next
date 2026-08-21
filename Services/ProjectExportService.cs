using System.IO.Compression;
using System.Security;
using System.Text;
using System.Globalization;
using DustDesk.Next.Models;
using Microsoft.Win32;

namespace DustDesk.Next.Services;

public sealed class ProjectExportService : IProjectExportService
{
    private static readonly string[] Headers = { "项目", "项目路径", "阶段", "状态", "开始日期", "截止日期", "进度", "阶段路径", "子事项", "完成", "子事项路径" };
    public string? Export(IReadOnlyCollection<ProjectRecord> projects)
    {
        if (projects.Count == 0) return null;
        var dialog = new SaveFileDialog { Title = "导出项目管理", Filter = "Excel 工作簿|*.xlsx", FileName = $"项目管理_{DateTime.Now:yyyyMMdd_HHmm}.xlsx", AddExtension = true, DefaultExt = "xlsx" };
        if (dialog.ShowDialog() != true) return null;
        WriteWorkbook(projects, dialog.FileName); return dialog.FileName;
    }
    private static void WriteWorkbook(IEnumerable<ProjectRecord> projects, string path)
    {
        using var stream = File.Create(path); using var archive = new ZipArchive(stream, ZipArchiveMode.Create);
        Add(archive, "[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/></Types>");
        Add(archive, "_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>");
        Add(archive, "xl/workbook.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"项目管理\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>");
        Add(archive, "xl/_rels/workbook.xml.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>");
        Add(archive, "xl/styles.xml", StylesXml);
        var sheet = BuildSheet(projects);
        Add(archive, "xl/worksheets/sheet1.xml", sheet.Xml);
        if (sheet.Relationships.Length > 0) Add(archive, "xl/worksheets/_rels/sheet1.xml.rels", sheet.Relationships);
    }
    private static SheetContent BuildSheet(IEnumerable<ProjectRecord> projects)
    {
        var rows = new List<string[]> { Headers };
        foreach (var project in projects)
        {
            if (project.Phases.Count == 0) rows.Add(Row(project, null, null));
            foreach (var phase in project.Phases)
            {
                if (phase.Subtasks.Count == 0) rows.Add(Row(project, phase, null));
                foreach (var subtask in phase.Subtasks) rows.Add(Row(project, phase, subtask));
            }
        }
        var builder = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews><cols><col min=\"1\" max=\"1\" width=\"20\" customWidth=\"1\"/><col min=\"2\" max=\"2\" width=\"34\" customWidth=\"1\"/><col min=\"3\" max=\"3\" width=\"22\" customWidth=\"1\"/><col min=\"4\" max=\"4\" width=\"12\" customWidth=\"1\"/><col min=\"5\" max=\"6\" width=\"13\" customWidth=\"1\"/><col min=\"7\" max=\"7\" width=\"10\" customWidth=\"1\"/><col min=\"8\" max=\"8\" width=\"34\" customWidth=\"1\"/><col min=\"9\" max=\"9\" width=\"24\" customWidth=\"1\"/><col min=\"10\" max=\"10\" width=\"10\" customWidth=\"1\"/><col min=\"11\" max=\"11\" width=\"42\" customWidth=\"1\"/></cols><sheetData>");
        var links = new List<(string Cell, string Target)>();
        for (var rowIndex = 0; rowIndex < rows.Count; rowIndex++)
        {
            builder.Append("<row r=\"").Append(rowIndex + 1).Append("\" ht=\"").Append(rowIndex == 0 ? "26" : "23").Append("\" customHeight=\"1\">");
            for (var column = 0; column < rows[rowIndex].Length; column++)
            {
                var cell = $"{ColumnName(column + 1)}{rowIndex + 1}";
                AppendCell(builder, cell, rows[rowIndex][column], rowIndex, column);
                if (rowIndex > 0 && (column == 1 || column == 7 || column == 10) && !string.IsNullOrWhiteSpace(rows[rowIndex][column])) links.Add((cell, ToLinkTarget(rows[rowIndex][column])));
            }
            builder.Append("</row>");
        }
        builder.Append("</sheetData><autoFilter ref=\"A1:K").Append(rows.Count).Append("\"/>");
        if (links.Count > 0)
        {
            builder.Append("<hyperlinks>");
            for (var index = 0; index < links.Count; index++) builder.Append("<hyperlink ref=\"").Append(links[index].Cell).Append("\" r:id=\"rId").Append(index + 1).Append("\"/>");
            builder.Append("</hyperlinks>");
        }
        builder.Append("</worksheet>");
        if (links.Count == 0) return new SheetContent(builder.ToString(), string.Empty);
        var relationships = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
        for (var index = 0; index < links.Count; index++) relationships.Append("<Relationship Id=\"rId").Append(index + 1).Append("\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"").Append(Escape(links[index].Target)).Append("\" TargetMode=\"External\"/>");
        relationships.Append("</Relationships>");
        return new SheetContent(builder.ToString(), relationships.ToString());
    }
    private static string ToLinkTarget(string value)
    {
        if (Uri.TryCreate(value, UriKind.Absolute, out var uri) && !uri.IsFile) return uri.AbsoluteUri;
        return new Uri(Path.GetFullPath(value)).AbsoluteUri;
    }
    private sealed record SheetContent(string Xml, string Relationships);
    private static void AppendCell(StringBuilder builder, string reference, string value, int rowIndex, int column)
    {
        if (rowIndex == 0)
        {
            builder.Append("<c r=\"").Append(reference).Append("\" s=\"1\" t=\"inlineStr\"><is><t>").Append(Escape(value)).Append("</t></is></c>");
            return;
        }
        if ((column == 4 || column == 5) && DateTime.TryParseExact(value, "yyyy/MM/dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
        {
            builder.Append("<c r=\"").Append(reference).Append("\" s=\"4\"><v>").Append((date.Date - new DateTime(1899, 12, 30)).TotalDays.ToString(CultureInfo.InvariantCulture)).Append("</v></c>");
            return;
        }
        if (column == 6 && value.EndsWith('%') && double.TryParse(value[..^1], CultureInfo.InvariantCulture, out var percent))
        {
            builder.Append("<c r=\"").Append(reference).Append("\" s=\"5\"><v>").Append((percent / 100d).ToString(CultureInfo.InvariantCulture)).Append("</v></c>");
            return;
        }
        var style = column == 1 || column == 7 || column == 10 ? 2 : 3;
        builder.Append("<c r=\"").Append(reference).Append("\" s=\"").Append(style).Append("\" t=\"inlineStr\"><is><t>").Append(Escape(value)).Append("</t></is></c>");
    }
    private const string StylesXml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy/mm/dd"/><numFmt numFmtId="165" formatCode="0%"/></numFmts>
          <fonts count="3"><font><sz val="10"/><name val="Microsoft YaHei UI"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Microsoft YaHei UI"/></font><font><u/><color rgb="FF0563C1"/><sz val="10"/><name val="Microsoft YaHei UI"/></font></fonts>
          <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills>
          <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFD9E2F3"/></bottom><diagonal/></border></borders>
          <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
          <cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf></cellXfs>
          <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
        </styleSheet>
        """;
    private static string[] Row(ProjectRecord project, ProjectPhaseRecord? phase, ProjectSubtaskRecord? subtask) => new[]
    {
        project.Name, project.ProjectPath, phase?.Title ?? "", StatusText(phase?.Status), phase?.StartDate?.ToString("yyyy/MM/dd") ?? "", phase?.EndDate?.ToString("yyyy/MM/dd") ?? "", phase is null ? "" : $"{Progress(phase)}%", phase?.ProjectPath ?? "", subtask?.Title ?? "", subtask is null ? "" : subtask.IsCompleted ? "是" : "否", subtask?.FilePath ?? ""
    };
    private static int Progress(ProjectPhaseRecord phase) => phase.ProgressPercent >= 0 ? Math.Clamp(phase.ProgressPercent, 0, 100) : phase.Subtasks.Count > 0 ? (int)Math.Round(phase.Subtasks.Count(item => item.IsCompleted) * 100d / phase.Subtasks.Count) : phase.Status switch { ProjectStatus.Done => 100, ProjectStatus.Doing => 50, _ => 0 };
    private static string StatusText(ProjectStatus? status) => status switch { ProjectStatus.Doing => "进行中", ProjectStatus.Done => "已完成", ProjectStatus.Todo => "待开始", _ => "" };
    private static string ColumnName(int number) { var result = ""; while (number > 0) { number--; result = (char)('A' + number % 26) + result; number /= 26; } return result; }
    private static string Escape(string value) => SecurityElement.Escape(value) ?? string.Empty;
    private static void Add(ZipArchive archive, string name, string content) { var entry = archive.CreateEntry(name, CompressionLevel.Fastest); using var writer = new StreamWriter(entry.Open(), new UTF8Encoding(false)); writer.Write(content); }
}
