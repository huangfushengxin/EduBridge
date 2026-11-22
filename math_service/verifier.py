"""Exact checks for a bounded mathematical AST. All strings are data."""
import re

import sympy as sp
from sympy.solvers.inequalities import solve_univariate_inequality


X = sp.Symbol("x", real=True)
RATIONAL = re.compile(r"-?[0-9]{1,5}(?:/[1-9][0-9]{0,4})?\Z")


class Unsupported(ValueError):
    """Invalid shape or outside the service's supported mathematical subset."""


def has_keys(obj, required, optional=()):
    if not isinstance(obj, dict) or not set(required) <= obj.keys() or obj.keys() - set(required) - set(optional):
        raise Unsupported("invalid_claim")


def rational(value):
    if type(value) is int and abs(value) <= 10000:
        return sp.Integer(value)
    if not isinstance(value, str) or len(value) > 12 or not RATIONAL.fullmatch(value):
        raise Unsupported("invalid_rational")
    parts = value.split("/")
    numerator = int(parts[0])
    denominator = int(parts[1]) if len(parts) == 2 else 1
    if abs(numerator) > 10000 or denominator > 10000:
        raise Unsupported("rational_limit")
    return sp.Rational(numerator, denominator)


def expression(root):
    nodes = 0
    nonzero = []

    def visit(node, depth):
        nonlocal nodes
        nodes += 1
        if nodes > 80 or depth > 9:
            raise Unsupported("expression_limit")
        if node == "x":
            return X, 1, 0, 1
        if not isinstance(node, dict):
            constant = rational(node)
            return constant, 0, 0, int(constant.p).bit_length() + int(constant.q).bit_length()
        has_keys(node, ("op", "args"))
        op, args = node["op"], node["args"]
        if not isinstance(op, str) or not isinstance(args, list) or len(args) != 2:
            raise Unsupported("invalid_expression")
        left, ln, ld, lc = visit(args[0], depth + 1)
        right, rn, rd, rc = visit(args[1], depth + 1)
        cost = lc + rc + 1
        if op in ("add", "sub"):
            n, d = max(ln + rd, rn + ld), ld + rd
        elif op == "mul":
            n, d = ln + rn, ld + rd
        elif op == "div":
            n, d = ln + rd, ld + rn
        elif op == "pow":
            if not isinstance(right, sp.Integer) or abs(right) > 6:
                raise Unsupported("bounded_integer_exponent_required")
            power = int(right)
            n, d = (ln * power, ld * power) if power >= 0 else (-ld * power, -ln * power)
            cost = lc * max(1, abs(power)) + rc + 1
        else:
            raise Unsupported("operator_unsupported")
        if max(n, d) > 8 or cost > 384:
            raise Unsupported("expression_complexity_limit")
        if op == "div" or (op == "pow" and power < 0):
            divisor = right if op == "div" else left
            if divisor == 0:
                raise Unsupported("zero_denominator")
            nonzero.append(divisor)
        if op == "add":
            result = left + right
        elif op == "sub":
            result = left - right
        elif op == "mul":
            result = left * right
        elif op == "div":
            result = left / right
        else:
            result = left**power
        return result, n, d, cost

    result, _, _, _ = visit(root, 0)
    for value in (result, *nonzero):
        numerator, denominator = sp.fraction(sp.cancel(value))
        if any(sp.Poly(poly, X).total_degree() > 8 for poly in (numerator, denominator)):
            raise Unsupported("polynomial_degree_limit")
    return result, nonzero


def finite(values, *, integers=False):
    if not isinstance(values, list) or len(values) > 48:
        raise Unsupported("finite_set_limit")
    if integers and any(type(value) is not int for value in values):
        raise Unsupported("finite_integer_set_required")
    return sp.FiniteSet(*(rational(value) for value in values))


def interval(spec):
    has_keys(spec, ("lower", "upper", "lower_closed", "upper_closed"), ("exclude",))
    if type(spec["lower_closed"]) is not bool or type(spec["upper_closed"]) is not bool:
        raise Unsupported("invalid_interval_boundary")
    lower = -sp.oo if spec["lower"] is None else rational(spec["lower"])
    upper = sp.oo if spec["upper"] is None else rational(spec["upper"])
    if lower > upper:
        raise Unsupported("invalid_interval_order")
    result = sp.Interval(lower, upper, not spec["lower_closed"], not spec["upper_closed"])
    return result - finite(spec.get("exclude", []))


def declared_domain(spec):
    result = interval(spec)
    if result == sp.S.EmptySet:
        raise Unsupported("empty_domain")
    return result


def same_set(left, right):
    if left == right:
        return True
    difference = left.symmetric_difference(right)
    if difference.is_empty is None:
        raise Unsupported("symbolic_result_undecided")
    return difference.is_empty


def condition(value):
    return {"status": "passed", "code": "symbolic_check_passed"} if value else {
        "status": "failed", "code": "claim_does_not_hold",
    }


def verify_claim(claim):
    if not isinstance(claim, dict):
        raise Unsupported("invalid_claim")
    kind = claim.get("kind")
    if kind == "set":
        has_keys(claim, ("kind", "op", "left", "right", "expected"))
        left = finite(claim["left"], integers=True)
        right = finite(claim["right"], integers=True)
        expected = finite(claim["expected"], integers=True)
        match claim["op"]:
            case "union":
                return condition(same_set(left | right, expected))
            case "intersection":
                return condition(same_set(left & right, expected))
            case "difference":
                return condition(same_set(left - right, expected))
            case _:
                raise Unsupported("set_operator_unsupported")

    if kind == "amgm2":
        has_keys(claim, ("kind", "domain", "a", "b", "claimed_lower", "equality_x"))
        domain = declared_domain(claim["domain"])
        a, b, lower, x_equal = (rational(claim[field]) for field in ("a", "b", "claimed_lower", "equality_x"))
        if not domain.is_subset(sp.Interval.open(0, sp.oo)) or a <= 0 or b <= 0:
            return {"status": "failed", "code": "positivity_condition_missing"}
        if domain.contains(x_equal) != sp.S.true:
            return {"status": "failed", "code": "equality_unreachable"}
        return condition(x_equal > 0 and a*x_equal**2 == b and lower == a*x_equal + b/x_equal)

    if kind not in ("equivalent", "equation", "inequality"):
        raise Unsupported("claim_kind_unsupported")
    fields = ("kind", "left", "right", "domain")
    has_keys(claim, fields if kind == "equivalent" else (*fields, "relation", "expected"))
    domain = declared_domain(claim["domain"])
    left, left_nonzero = expression(claim["left"])
    right, right_nonzero = expression(claim["right"])
    for denominator in left_nonzero + right_nonzero:
        zeros = sp.solveset(denominator, X, domain)
        if isinstance(zeros, sp.ConditionSet):
            raise Unsupported("denominator_domain_undecided")
        if zeros != sp.S.EmptySet:
            return {"status": "failed", "code": "domain_contains_undefined_point"}

    difference = sp.cancel(left - right)
    if kind == "equivalent":
        return condition(difference == 0 or same_set(sp.solveset(difference, X, domain), domain))

    expected = finite(claim["expected"]) if isinstance(claim["expected"], list) else interval(claim["expected"])
    relation = claim["relation"]
    if kind == "equation" and relation == "eq":
        solved = sp.solveset(difference, X, domain)
    elif kind == "inequality" and isinstance(relation, str) and relation in ("gt", "ge", "lt", "le"):
        comparison = {"gt": sp.Gt, "ge": sp.Ge, "lt": sp.Lt, "le": sp.Le}[relation](difference, 0)
        if comparison in (sp.S.true, sp.S.false):
            solved = domain if comparison == sp.S.true else sp.S.EmptySet
        else:
            solved = solve_univariate_inequality(comparison, X, relational=False) & domain
    else:
        raise Unsupported("relation_unsupported")
    if isinstance(solved, sp.ConditionSet):
        raise Unsupported("symbolic_result_undecided")
    return condition(same_set(solved, expected))


def verify_batch(claims):
    if not isinstance(claims, list) or not 1 <= len(claims) <= 3:
        return {"status": "unsupported", "code": "claim_count_unsupported"}
    results = []
    for claim in claims:
        try:
            results.append(verify_claim(claim))
        except Unsupported as error:
            results.append({"status": "unsupported", "code": str(error)})
        except (NotImplementedError, ValueError, TypeError, sp.PolynomialError):
            results.append({"status": "unsupported", "code": "symbolic_result_undecided"})
    for state in ("failed", "unsupported"):
        match = next((entry for entry in results if entry["status"] == state), None)
        if match:
            return {**match, "checks": results}
    return {"status": "passed", "code": "symbolic_check_passed", "checks": results}
