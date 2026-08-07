using System.Text.Json;
using System.Text.RegularExpressions;

internal sealed record AgentRuntimeSchemaValidationResult(
    bool Valid,
    string? Path = null,
    string? Message = null);

internal static class AgentRuntimeToolSchemaValidator
{
    private const int MaxSchemaDepth = 64;
    private static readonly TimeSpan PatternTimeout = TimeSpan.FromMilliseconds(100);
    private static readonly HashSet<string> AllowedKeywords = new(StringComparer.Ordinal)
    {
        "$defs", "$ref", "$schema", "additionalProperties", "allOf", "anyOf", "const",
        "default", "definitions", "deprecated", "description", "else", "enum", "examples",
        "exclusiveMaximum", "exclusiveMinimum", "format", "items", "maxItems", "maxLength",
        "maxProperties", "maximum", "minItems", "minLength", "minProperties", "minimum",
        "multipleOf", "not", "oneOf", "pattern", "properties", "readOnly", "required", "then",
        "title", "type", "uniqueItems", "writeOnly", "if"
    };
    private static readonly HashSet<string> SupportedTypes = new(StringComparer.Ordinal)
    {
        "object", "array", "string", "number", "integer", "boolean", "null"
    };

    public static bool ValidateSchema(JsonElement schema, out string? error)
    {
        try
        {
            ValidateSchemaNode(schema, schema, "$", 0, new HashSet<string>(StringComparer.Ordinal));
            error = null;
            return true;
        }
        catch (SchemaException exception)
        {
            error = $"{exception.Path}: {exception.Message}";
            return false;
        }
    }

    public static AgentRuntimeSchemaValidationResult Validate(JsonElement schema, JsonElement value)
    {
        if (!ValidateSchema(schema, out var schemaError))
        {
            return new AgentRuntimeSchemaValidationResult(false, "$schema", schemaError);
        }

        var failure = ValidateValue(schema, schema, value, "$", 0, new HashSet<string>(StringComparer.Ordinal));
        return failure is null
            ? new AgentRuntimeSchemaValidationResult(true)
            : new AgentRuntimeSchemaValidationResult(false, failure.Value.Path, failure.Value.Message);
    }

    private static void ValidateSchemaNode(
        JsonElement root,
        JsonElement schema,
        string path,
        int depth,
        HashSet<string> refs)
    {
        EnsureDepth(depth, path);
        if (schema.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            return;
        }
        if (schema.ValueKind != JsonValueKind.Object)
        {
            throw new SchemaException(path, "Schema must be an object or boolean.");
        }

        foreach (var property in schema.EnumerateObject())
        {
            if (!AllowedKeywords.Contains(property.Name))
            {
                throw new SchemaException(path, $"Unsupported schema keyword '{property.Name}'.");
            }
        }

        if (schema.TryGetProperty("$ref", out var reference))
        {
            if (reference.ValueKind != JsonValueKind.String ||
                reference.GetString() is not { Length: > 0 } referenceText ||
                !referenceText.StartsWith('#'))
            {
                throw new SchemaException(path, "Only local $ref values are supported.");
            }
            if (!refs.Add(referenceText))
            {
                throw new SchemaException(path, $"Cyclic $ref '{referenceText}' is not supported.");
            }
            ValidateSchemaNode(root, ResolveReference(root, referenceText, path), path, depth + 1, refs);
            refs.Remove(referenceText);
        }

        if (schema.TryGetProperty("type", out var type))
        {
            ValidateTypeKeyword(type, path);
        }

        ValidateSchemaMap(root, schema, "properties", path, depth, refs);
        ValidateSchemaMap(root, schema, "$defs", path, depth, refs);
        ValidateSchemaMap(root, schema, "definitions", path, depth, refs);

        if (schema.TryGetProperty("required", out var required))
        {
            if (required.ValueKind != JsonValueKind.Array ||
                required.EnumerateArray().Any(item => item.ValueKind != JsonValueKind.String))
            {
                throw new SchemaException(path, "required must be an array of strings.");
            }
        }

        if (schema.TryGetProperty("additionalProperties", out var additional))
        {
            if (additional.ValueKind is not (JsonValueKind.True or JsonValueKind.False or JsonValueKind.Object))
            {
                throw new SchemaException(path, "additionalProperties must be a boolean or schema.");
            }
            if (additional.ValueKind == JsonValueKind.Object)
            {
                ValidateSchemaNode(root, additional, $"{path}.additionalProperties", depth + 1, refs);
            }
        }

        if (schema.TryGetProperty("items", out var items))
        {
            ValidateSchemaNode(root, items, $"{path}.items", depth + 1, refs);
        }

        foreach (var keyword in new[] { "oneOf", "anyOf", "allOf" })
        {
            if (!schema.TryGetProperty(keyword, out var alternatives))
            {
                continue;
            }
            if (alternatives.ValueKind != JsonValueKind.Array || alternatives.GetArrayLength() == 0)
            {
                throw new SchemaException(path, $"{keyword} must be a non-empty array.");
            }
            var index = 0;
            foreach (var alternative in alternatives.EnumerateArray())
            {
                ValidateSchemaNode(root, alternative, $"{path}.{keyword}[{index}]", depth + 1, refs);
                index++;
            }
        }

        foreach (var keyword in new[] { "not", "if", "then", "else" })
        {
            if (schema.TryGetProperty(keyword, out var nested))
            {
                ValidateSchemaNode(root, nested, $"{path}.{keyword}", depth + 1, refs);
            }
        }

        if (schema.TryGetProperty("enum", out var enumValues) &&
            (enumValues.ValueKind != JsonValueKind.Array || enumValues.GetArrayLength() == 0))
        {
            throw new SchemaException(path, "enum must be a non-empty array.");
        }

        ValidateNonNegativeInteger(schema, "minLength", path);
        ValidateNonNegativeInteger(schema, "maxLength", path);
        ValidateNonNegativeInteger(schema, "minItems", path);
        ValidateNonNegativeInteger(schema, "maxItems", path);
        ValidateNonNegativeInteger(schema, "minProperties", path);
        ValidateNonNegativeInteger(schema, "maxProperties", path);
        ValidateNumberKeyword(schema, "minimum", path);
        ValidateNumberKeyword(schema, "maximum", path);
        ValidateNumberKeyword(schema, "exclusiveMinimum", path);
        ValidateNumberKeyword(schema, "exclusiveMaximum", path);
        ValidateNumberKeyword(schema, "multipleOf", path, requirePositive: true);

        if (schema.TryGetProperty("pattern", out var pattern))
        {
            if (pattern.ValueKind != JsonValueKind.String)
            {
                throw new SchemaException(path, "pattern must be a string.");
            }
            try
            {
                _ = new Regex(pattern.GetString() ?? string.Empty, RegexOptions.None, PatternTimeout);
            }
            catch (ArgumentException exception)
            {
                throw new SchemaException(path, $"Invalid regex pattern: {exception.Message}");
            }
        }
    }

    private static ValidationFailure? ValidateValue(
        JsonElement root,
        JsonElement schema,
        JsonElement value,
        string path,
        int depth,
        HashSet<string> refs)
    {
        EnsureDepth(depth, path);
        if (schema.ValueKind == JsonValueKind.True) return null;
        if (schema.ValueKind == JsonValueKind.False)
        {
            return new ValidationFailure(path, "Value is rejected by the schema.");
        }

        if (schema.TryGetProperty("$ref", out var reference))
        {
            var text = reference.GetString()!;
            if (!refs.Add(text))
            {
                return new ValidationFailure(path, $"Cyclic $ref '{text}'.");
            }
            var result = ValidateValue(root, ResolveReference(root, text, path), value, path, depth + 1, refs);
            refs.Remove(text);
            if (result is not null) return result;
        }

        if (schema.TryGetProperty("allOf", out var allOf))
        {
            foreach (var child in allOf.EnumerateArray())
            {
                var failure = ValidateValue(root, child, value, path, depth + 1, refs);
                if (failure is not null) return failure;
            }
        }

        if (schema.TryGetProperty("anyOf", out var anyOf) &&
            !anyOf.EnumerateArray().Any(child =>
                ValidateValue(root, child, value, path, depth + 1, new HashSet<string>(refs)) is null))
        {
            return new ValidationFailure(path, "Value does not match any anyOf branch.");
        }

        if (schema.TryGetProperty("oneOf", out var oneOf))
        {
            var matches = oneOf.EnumerateArray().Count(child =>
                ValidateValue(root, child, value, path, depth + 1, new HashSet<string>(refs)) is null);
            if (matches != 1)
            {
                return new ValidationFailure(path, $"Value must match exactly one oneOf branch; matched {matches}.");
            }
        }

        if (schema.TryGetProperty("not", out var not) &&
            ValidateValue(root, not, value, path, depth + 1, new HashSet<string>(refs)) is null)
        {
            return new ValidationFailure(path, "Value matches a forbidden not schema.");
        }

        if (schema.TryGetProperty("if", out var condition))
        {
            var conditionMatched =
                ValidateValue(root, condition, value, path, depth + 1, new HashSet<string>(refs)) is null;
            var branchName = conditionMatched ? "then" : "else";
            if (schema.TryGetProperty(branchName, out var branch))
            {
                var failure = ValidateValue(root, branch, value, path, depth + 1, refs);
                if (failure is not null) return failure;
            }
        }

        if (schema.TryGetProperty("type", out var type) && !MatchesType(type, value))
        {
            return new ValidationFailure(path, $"Expected {DescribeType(type)}, got {DescribeValue(value)}.");
        }

        if (schema.TryGetProperty("const", out var constant) && !JsonEquals(constant, value))
        {
            return new ValidationFailure(path, "Value does not match const.");
        }
        if (schema.TryGetProperty("enum", out var enumValues) &&
            !enumValues.EnumerateArray().Any(item => JsonEquals(item, value)))
        {
            return new ValidationFailure(path, "Value is not one of the allowed enum values.");
        }

        if (value.ValueKind == JsonValueKind.Object)
        {
            var properties = schema.TryGetProperty("properties", out var propertySchemas) &&
                propertySchemas.ValueKind == JsonValueKind.Object
                ? propertySchemas
                : default;
            if (schema.TryGetProperty("required", out var required))
            {
                foreach (var item in required.EnumerateArray())
                {
                    var name = item.GetString()!;
                    if (!value.TryGetProperty(name, out _))
                    {
                        return new ValidationFailure(PropertyPath(path, name), "Required property is missing.");
                    }
                }
            }

            foreach (var property in value.EnumerateObject())
            {
                if (properties.ValueKind == JsonValueKind.Object &&
                    properties.TryGetProperty(property.Name, out var propertySchema))
                {
                    var failure = ValidateValue(
                        root,
                        propertySchema,
                        property.Value,
                        PropertyPath(path, property.Name),
                        depth + 1,
                        refs);
                    if (failure is not null) return failure;
                    continue;
                }

                if (schema.TryGetProperty("additionalProperties", out var additional))
                {
                    if (additional.ValueKind == JsonValueKind.False)
                    {
                        return new ValidationFailure(
                            PropertyPath(path, property.Name),
                            "Additional property is not allowed.");
                    }
                    if (additional.ValueKind == JsonValueKind.Object)
                    {
                        var failure = ValidateValue(
                            root,
                            additional,
                            property.Value,
                            PropertyPath(path, property.Name),
                            depth + 1,
                            refs);
                        if (failure is not null) return failure;
                    }
                }
            }

            var propertyCount = value.EnumerateObject().Count();
            if (TryReadInt(schema, "minProperties", out var minProperties) && propertyCount < minProperties)
            {
                return new ValidationFailure(path, $"Object must contain at least {minProperties} properties.");
            }
            if (TryReadInt(schema, "maxProperties", out var maxProperties) && propertyCount > maxProperties)
            {
                return new ValidationFailure(path, $"Object must contain at most {maxProperties} properties.");
            }
        }

        if (value.ValueKind == JsonValueKind.Array)
        {
            if (schema.TryGetProperty("items", out var items))
            {
                var index = 0;
                foreach (var item in value.EnumerateArray())
                {
                    var failure = ValidateValue(root, items, item, $"{path}[{index}]", depth + 1, refs);
                    if (failure is not null) return failure;
                    index++;
                }
            }
            var length = value.GetArrayLength();
            if (TryReadInt(schema, "minItems", out var minItems) && length < minItems)
            {
                return new ValidationFailure(path, $"Array must contain at least {minItems} items.");
            }
            if (TryReadInt(schema, "maxItems", out var maxItems) && length > maxItems)
            {
                return new ValidationFailure(path, $"Array must contain at most {maxItems} items.");
            }
            if (JsonHelpers.GetBool(schema, "uniqueItems", false))
            {
                var seen = new List<JsonElement>();
                foreach (var item in value.EnumerateArray())
                {
                    if (seen.Any(existing => JsonEquals(existing, item)))
                    {
                        return new ValidationFailure(path, "Array items must be unique.");
                    }
                    seen.Add(item);
                }
            }
        }

        if (value.ValueKind == JsonValueKind.String)
        {
            var text = value.GetString() ?? string.Empty;
            if (TryReadInt(schema, "minLength", out var minLength) && text.Length < minLength)
            {
                return new ValidationFailure(path, $"String must be at least {minLength} characters.");
            }
            if (TryReadInt(schema, "maxLength", out var maxLength) && text.Length > maxLength)
            {
                return new ValidationFailure(path, $"String must be at most {maxLength} characters.");
            }
            if (schema.TryGetProperty("pattern", out var pattern) &&
                !Regex.IsMatch(text, pattern.GetString() ?? string.Empty, RegexOptions.None, PatternTimeout))
            {
                return new ValidationFailure(path, "String does not match the required pattern.");
            }
        }

        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number))
        {
            if (TryReadDouble(schema, "minimum", out var minimum) && number < minimum)
                return new ValidationFailure(path, $"Number must be at least {minimum}.");
            if (TryReadDouble(schema, "maximum", out var maximum) && number > maximum)
                return new ValidationFailure(path, $"Number must be at most {maximum}.");
            if (TryReadDouble(schema, "exclusiveMinimum", out var exclusiveMinimum) && number <= exclusiveMinimum)
                return new ValidationFailure(path, $"Number must be greater than {exclusiveMinimum}.");
            if (TryReadDouble(schema, "exclusiveMaximum", out var exclusiveMaximum) && number >= exclusiveMaximum)
                return new ValidationFailure(path, $"Number must be less than {exclusiveMaximum}.");
            if (TryReadDouble(schema, "multipleOf", out var multipleOf))
            {
                var quotient = number / multipleOf;
                if (Math.Abs(quotient - Math.Round(quotient)) > 1e-9)
                    return new ValidationFailure(path, $"Number must be a multiple of {multipleOf}.");
            }
        }

        return null;
    }

    private static void ValidateSchemaMap(
        JsonElement root,
        JsonElement schema,
        string keyword,
        string path,
        int depth,
        HashSet<string> refs)
    {
        if (!schema.TryGetProperty(keyword, out var map)) return;
        if (map.ValueKind != JsonValueKind.Object)
        {
            throw new SchemaException(path, $"{keyword} must be an object.");
        }
        foreach (var property in map.EnumerateObject())
        {
            ValidateSchemaNode(root, property.Value, $"{path}.{keyword}.{property.Name}", depth + 1, refs);
        }
    }

    private static void ValidateTypeKeyword(JsonElement type, string path)
    {
        if (type.ValueKind == JsonValueKind.String)
        {
            if (!SupportedTypes.Contains(type.GetString() ?? string.Empty))
                throw new SchemaException(path, $"Unsupported type '{type.GetString()}'.");
            return;
        }
        if (type.ValueKind != JsonValueKind.Array || type.GetArrayLength() == 0)
            throw new SchemaException(path, "type must be a string or non-empty string array.");
        foreach (var item in type.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String || !SupportedTypes.Contains(item.GetString() ?? string.Empty))
                throw new SchemaException(path, "type array contains an unsupported value.");
        }
    }

    private static bool MatchesType(JsonElement type, JsonElement value)
    {
        if (type.ValueKind == JsonValueKind.String) return MatchesType(type.GetString()!, value);
        return type.EnumerateArray().Any(item => MatchesType(item.GetString()!, value));
    }

    private static bool MatchesType(string type, JsonElement value)
    {
        return type switch
        {
            "object" => value.ValueKind == JsonValueKind.Object,
            "array" => value.ValueKind == JsonValueKind.Array,
            "string" => value.ValueKind == JsonValueKind.String,
            "number" => value.ValueKind == JsonValueKind.Number,
            "integer" => value.ValueKind == JsonValueKind.Number &&
                value.TryGetDouble(out var number) && Math.Abs(number - Math.Round(number)) < 1e-12,
            "boolean" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
            "null" => value.ValueKind == JsonValueKind.Null,
            _ => false
        };
    }

    private static JsonElement ResolveReference(JsonElement root, string reference, string path)
    {
        if (reference == "#") return root;
        if (!reference.StartsWith("#/", StringComparison.Ordinal))
            throw new SchemaException(path, $"Unsupported local $ref '{reference}'.");
        var current = root;
        foreach (var rawSegment in reference[2..].Split('/'))
        {
            var segment = rawSegment.Replace("~1", "/", StringComparison.Ordinal)
                .Replace("~0", "~", StringComparison.Ordinal);
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
                throw new SchemaException(path, $"Unresolved local $ref '{reference}'.");
        }
        return current;
    }

    private static bool JsonEquals(JsonElement left, JsonElement right)
    {
        if (left.ValueKind != right.ValueKind)
        {
            if (left.ValueKind == JsonValueKind.Number && right.ValueKind == JsonValueKind.Number)
                return left.TryGetDecimal(out var leftNumber) && right.TryGetDecimal(out var rightNumber) &&
                    leftNumber == rightNumber;
            return false;
        }
        return left.ValueKind switch
        {
            JsonValueKind.Object => ObjectEquals(left, right),
            JsonValueKind.Array => ArrayEquals(left, right),
            JsonValueKind.String => left.GetString() == right.GetString(),
            JsonValueKind.Number => left.TryGetDecimal(out var leftNumber) &&
                right.TryGetDecimal(out var rightNumber) && leftNumber == rightNumber,
            JsonValueKind.True or JsonValueKind.False => left.GetBoolean() == right.GetBoolean(),
            JsonValueKind.Null => true,
            _ => left.GetRawText() == right.GetRawText()
        };
    }

    private static bool ObjectEquals(JsonElement left, JsonElement right)
    {
        var leftProperties = left.EnumerateObject().ToDictionary(item => item.Name, item => item.Value);
        var rightProperties = right.EnumerateObject().ToDictionary(item => item.Name, item => item.Value);
        return leftProperties.Count == rightProperties.Count && leftProperties.All(item =>
            rightProperties.TryGetValue(item.Key, out var value) && JsonEquals(item.Value, value));
    }

    private static bool ArrayEquals(JsonElement left, JsonElement right)
    {
        var leftItems = left.EnumerateArray().ToArray();
        var rightItems = right.EnumerateArray().ToArray();
        return leftItems.Length == rightItems.Length &&
            leftItems.Select((item, index) => JsonEquals(item, rightItems[index])).All(result => result);
    }

    private static void ValidateNonNegativeInteger(JsonElement schema, string keyword, string path)
    {
        if (schema.TryGetProperty(keyword, out var value) &&
            (!value.TryGetInt32(out var number) || number < 0))
            throw new SchemaException(path, $"{keyword} must be a non-negative integer.");
    }

    private static void ValidateNumberKeyword(
        JsonElement schema,
        string keyword,
        string path,
        bool requirePositive = false)
    {
        if (!schema.TryGetProperty(keyword, out var value)) return;
        if (!value.TryGetDouble(out var number) || !double.IsFinite(number) || (requirePositive && number <= 0))
            throw new SchemaException(path, $"{keyword} must be a valid{(requirePositive ? " positive" : string.Empty)} number.");
    }

    private static bool TryReadInt(JsonElement schema, string keyword, out int value)
    {
        value = 0;
        return schema.TryGetProperty(keyword, out var element) && element.TryGetInt32(out value);
    }

    private static bool TryReadDouble(JsonElement schema, string keyword, out double value)
    {
        value = 0;
        return schema.TryGetProperty(keyword, out var element) && element.TryGetDouble(out value);
    }

    private static string DescribeType(JsonElement type)
    {
        return type.ValueKind == JsonValueKind.String
            ? type.GetString() ?? "unknown"
            : string.Join(" or ", type.EnumerateArray().Select(item => item.GetString()));
    }

    private static string DescribeValue(JsonElement value)
    {
        return value.ValueKind switch
        {
            JsonValueKind.True or JsonValueKind.False => "boolean",
            JsonValueKind.Undefined => "undefined",
            _ => value.ValueKind.ToString().ToLowerInvariant()
        };
    }

    private static string PropertyPath(string path, string property)
    {
        return Regex.IsMatch(property, "^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.None, PatternTimeout)
            ? $"{path}.{property}"
            : $"{path}[{JsonSerializer.Serialize(property, WorkerJsonContext.Default.String)}]";
    }

    private static void EnsureDepth(int depth, string path)
    {
        if (depth > MaxSchemaDepth) throw new SchemaException(path, "Schema nesting exceeds limit.");
    }

    private readonly record struct ValidationFailure(string Path, string Message);

    private sealed class SchemaException(string path, string message) : Exception(message)
    {
        public string Path { get; } = path;
    }
}
